/**
 * mediaEngine — the one media object the player talks to.
 *
 * The player is written against the slice of `HTMLMediaElement` it actually
 * uses: `currentTime`, `duration`, `paused`, `muted`, `play()`, `pause()`, and
 * nine event names. That is deliberate — it is what lets AVPlay be added
 * behind a stable object instead of rewriting ten hooks.
 *
 * The facade is an `EventTarget`, and every backend event is re-dispatched
 * from it, so `event.target` is always this object. `usePlayerMedia`'s error
 * guard is `e.target !== v || !v.error`; an element's own event would have the
 * element as its target and the guard would silently drop every genuine media
 * error. The backend must assign `.error` **before** it emits `error`, which
 * is why the HTML5 backend forwards the native event only after the element
 * has already set it.
 *
 * The facade's identity never changes. Only `kind` and `capabilities` change
 * when the backend is swapped, so listeners registered by the hooks survive an
 * engine switch. See avplayBackend.js for the other side.
 *
 * ## Load-bearing getter contracts
 *
 * - `currentTime` reports the requested seek target while a seek is in flight
 *   (AVPlay), because `useSkim` reads it straight after writing it. The HTML5
 *   backend has native seek state and needs no such rule.
 * - `duration` is `NaN` — never 0 — before a source is prepared, because the
 *   player's timeline logic tests `Number.isFinite(d) && d > 0`.
 * - `muted` reflects the *requested* state synchronously. `setMuted` reverts
 *   and reports failure if the native call throws, so the button cannot claim
 *   a mute that is not happening.
 * - `buffered`, `seekable`, `networkState`, `videoWidth`, `videoHeight` and
 *   the frame counters are always readable and never throw, even on AVPlay
 *   where most of them mean nothing. `playbackStats` reads all of them.
 */

import { createHtml5Backend } from './html5Backend.js';
import { createAvplayBackend } from './avplayBackend.js';

export { MEDIA_EVENTS, emptyTimeRanges } from './contracts.js';

const HTML5_CAPABILITIES = { mute: 'property', stats: 'full', seek: 'native' };

class MediaFacade extends EventTarget {
  constructor() {
    super();
    /** @type {'html5'|'avplay'} */
    this.kind = 'html5';
    /**
     * What the active backend can do. The Settings lever does not read these;
     * the mute button and the stats panel do.
     * `stats: 'reduced'` means buffer/seekable/readyState/frames/resolution
     * have no honest value and the panel must leave them out rather than print
     * placeholders that look like measurements.
     */
    this.capabilities = { ...HTML5_CAPABILITIES };

    // Both backends are kept alive for the life of the player. Only one is
    // active, and swapping does not recreate the inactive one: the HTML5
    // backend owns the <video> attachment, which must survive an engine
    // fallback back to the browser.
    this._html5 = createHtml5Backend({
      emit: (type) => this.dispatchEvent(new Event(type)),
    });
    this._avplay = null;
    this._avplayApi = null;
  }

  /**
   * Choose the backend. Called from a layout effect on every engine change, so
   * the backend is in place before the player's passive effects open a source.
   *
   * Switching **away** from AVPlay closes the native session here, not in the
   * player: a passive-effect cleanup runs after layout effects, by which time
   * `media.close()` would close the new backend instead — and on the HTML5
   * path that would clear the `src` React had just set in the same commit.
   */
  setEngine(kind, { avplay = null, tvaudiocontrol = null } = {}) {
    if (kind === 'avplay' && (!this._avplay || this._avplayApi !== avplay)) {
      this._avplay?.close();
      this._avplay = createAvplayBackend({
        avplay,
        tvaudiocontrol,
        emit: (type) => this.dispatchEvent(new Event(type)),
      });
      this._avplayApi = avplay;
    }
    const next = kind === 'avplay' ? 'avplay' : 'html5';
    if (this.kind === next) return;
    if (this.kind === 'avplay') this._avplay?.close();
    this.kind = next;
    this.capabilities = next === 'avplay'
      ? { ...this._avplay.capabilities }
      : { ...HTML5_CAPABILITIES };
  }

  get _engine() {
    return this.kind === 'avplay' ? this._avplay : this._html5;
  }

  // ── Attachment (HTML5 only) ──────────────────────────────
  // Unconditional: the player calls these from the <video>'s callback ref,
  // which only exists on the browser path, and an engine switch must not lose
  // the attachment for the way back.
  attachVideoElement(el) {
    this._html5.attach(el);
  }

  detachVideoElement() {
    this._html5.detach();
  }

  // ── MediaElement-shaped surface ──────────────────────────
  get paused() { return !!this._engine.paused; }
  get duration() { return this._engine.duration; }
  get currentTime() { return this._engine.currentTime; }
  set currentTime(seconds) { this._engine.currentTime = seconds; }
  get readyState() { return this._engine.readyState; }
  get networkState() { return this._engine.networkState; }
  get muted() { return !!this._engine.muted; }
  set muted(value) { this._engine.muted = !!value; }
  get volume() { return this._engine.volume; }
  set volume(value) { this._engine.volume = value; }
  get playbackRate() { return this._engine.playbackRate; }
  get error() { return this._engine.error; }
  get buffered() { return this._engine.buffered; }
  get seekable() { return this._engine.seekable; }
  get videoWidth() { return this._engine.videoWidth; }
  get videoHeight() { return this._engine.videoHeight; }
  get webkitDecodedFrameCount() { return this._engine.webkitDecodedFrameCount; }
  get webkitDroppedFrameCount() { return this._engine.webkitDroppedFrameCount; }

  play() { return this._engine.play(); }
  pause() { this._engine.pause(); }
  seek(seconds) { this._engine.currentTime = seconds; }
  getVideoPlaybackQuality() { return this._engine.getVideoPlaybackQuality(); }

  /** Whether the active backend produced a frame; used by the resolver's
   *  success latch so the kill switch counts real playback, not a request. */
  get lastFailure() { return this._avplay?.getLastFailure?.() ?? null; }
  // Only while AVPlay is the engine on screen. A seek degradation is the
  // reason a scene may have moved to the browser; once it has, the row would
  // describe an engine that is no longer playing.
  get seekDegraded() {
    return this.kind === 'avplay' && !!this._avplay?.isSeekDegraded?.();
  }
  getMuteCapability() { return this.capabilities.mute; }
  setMuted(value) {
    const backend = this._engine;
    if (typeof backend.setMuted === 'function') return backend.setMuted(value);
    backend.muted = !!value;
    return true;
  }

  /** Open a URL on the backend that owns loading. HTML5 is a no-op here when
   *  the <video> already carries `src` (it does, through JSX). AVPlay uses
   *  this as its load path. */
  open(url, opts) { return this._engine.open(url, opts); }

  /**
   * End the AVPlay session, if any. Deliberately not "close the active
   * backend": the browser path's teardown is the <video> unmounting, and
   * clearing its `src` from here would race the JSX assignment on an engine
   * fallback.
   */
  close() { this._avplay?.close(); }
}

export function createMediaEngine() {
  return new MediaFacade();
}
