/**
 * mediaEngine — the one media object the player talks to: the slice of
 * `HTMLMediaElement` the hooks actually use. That stability is what lets AVPlay
 * be added behind it instead of rewriting them.
 *
 * The facade is an `EventTarget`, and every backend event is re-dispatched from
 * it, so `event.target` is always this object. `usePlayerMedia`'s guard is
 * `e.target !== v || !v.error`; an element's own event would be dropped. The
 * backend must assign `.error` **before** it emits `error`.
 *
 * Identity never changes — only `kind` and `capabilities` on a swap — so hook
 * listeners survive an engine switch. See avplayBackend.js for the other side.
 *
 * ## Load-bearing getter contracts
 *
 * - `currentTime` reports the requested seek target while a seek is in flight
 *   (AVPlay), because `useSkim` reads it straight after writing it.
 * - `duration` is `NaN` — never 0 — before a source is prepared, because the
 *   timeline logic tests `Number.isFinite(d) && d > 0`.
 * - `muted` reflects the *requested* state synchronously; `setMuted` reverts
 *   and reports failure if the native call throws.
 * - `buffered`, `seekable`, `networkState`, the resolution and frame counters
 *   are always readable and never throw, even on AVPlay. `playbackStats` reads
 *   all of them.
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
     * What the active backend can do — read by the mute button and the stats
     * panel, not the Settings lever. `stats: 'reduced'` means buffer, seekable,
     * readyState, frames and resolution have no honest value, so the panel must
     * omit them rather than print placeholders that look like measurements.
     */
    this.capabilities = { ...HTML5_CAPABILITIES };

    // Both backends live for the whole player. Only one is active, and a swap
    // does not recreate the other: the HTML5 backend owns the <video>
    // attachment, which must survive a fallback back to the browser.
    this._html5 = createHtml5Backend({
      emit: (type) => this.dispatchEvent(new Event(type)),
    });
    this._avplay = null;
    this._avplayApi = null;
  }

  /**
   * Choose the backend. Called from a layout effect on every engine change, so
   * the backend is in place before the passive effects open a source.
   *
   * Switching **away** from AVPlay closes the native session here: a passive
   * cleanup would run after layout effects, by which time it would close the
   * new backend — and clear the `src` React had just set.
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
  // Unconditional: called from the <video>'s callback ref, which only exists
  // on the browser path, and a switch must not lose the attachment for the way
  // back.
  attachVideoElement(el) {
    this._html5.attach(el);
  }

  detachVideoElement() {
    this._html5.detach();
  }

  // ── MediaElement-shaped surface ──────────────────────────
  get paused() { return !!this._engine.paused; }
  // A seek in flight is not a pause: `paused` carries the user's intent, while
  // the progress reporter uses `paused || seeking` so a skip is never credited.
  get seeking() { return !!this._engine.seeking; }
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
  // Only while AVPlay is on screen: a seek degradation may already have moved
  // the scene to the browser, and the row would describe the wrong engine.
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

  /** Open a URL on the backend that owns loading. HTML5 is a no-op (the <video>
   *  already carries `src` through JSX); this is AVPlay's load path. */
  open(url, opts) { return this._engine.open(url, opts); }

  /**
   * End the AVPlay session, if any. Not "close the active backend": the browser
   * path tears down with the <video> unmount, and clearing its `src` here would
   * race the JSX assignment on an engine fallback.
   */
  close() { this._avplay?.close(); }
}

export function createMediaEngine() {
  return new MediaFacade();
}
