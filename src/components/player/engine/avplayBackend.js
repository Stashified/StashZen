/**
 * avplayBackend — the TV's own player, behind the media facade.
 *
 * AVPlay is not an `HTMLMediaElement`: it has no DOM node, no events, no
 * buffer or seekable ranges, and it draws *behind* the page rather than inside
 * it. This adapter turns it into the same small object html5Backend presents,
 * so the player's hooks do not know which engine is running. What it cannot
 * honestly supply (buffer, seekable, readyState, resolution, frame counts) is
 * left neutral and hidden from the stats panel by `capabilities.stats`.
 *
 * The shape and the calls come from the Phase 0 probe that ran on the target
 * panel (Tizen 9.0, AVPlay 7.0). Things it settled that the code depends on:
 *
 *   - `prepareAsync` fails in 110–276 ms for a refused codec, with no hangs.
 *     A 6 s watchdog is still armed, but it is a safety net, not the normal
 *     path.
 *   - There are no seek callbacks worth trusting: a seek is settled by polling
 *     the position, which is what `seekCoalescer` does.
 *   - `restore(null, position, prepare)` throws `TypeError`; only the no-arg
 *     `restore()` works. A restore can also lose its place by several seconds,
 *     so the cached position is authoritative and is re-asserted.
 *   - There is no `setVolume`. Mute goes through the TV's own audio API when
 *     the panel exposes it; see volumeMapping.js.
 *
 * **Every callback carries the generation it was registered under.** The
 * native player can deliver a late `onerror` or `onstreamcompleted` for a
 * session that has already been closed, and a player that reacts to one of
 * those reports an error for the scene it replaced.
 *
 * Error handling is phase-based, because a refused codec and a broken engine
 * both arrive as `PLAYER_ERROR_CONNECTION_FAILED` here. `lastFailure` keeps the
 * classified result so the source resolver can decide between "try the next
 * candidate" and "stop using AVPlay".
 */

import {
  classifyAvplayError, describeAvplayFailure,
} from '../../../utils/avplayErrors.js';
import {
  createSeekCoalescer, SEEK_SETTLE_MS, SEEK_SETTLE_HLS_MS, SEEK_MAX_WAIT_MS,
} from '../../../utils/seekCoalescer.js';
import {
  detectMuteCapability, mapMute, mapMuteRestore, clampLevel,
} from '../../../utils/volumeMapping.js';
import { emptyTimeRanges } from './contracts.js';

// Measured refusals arrive in under 300 ms; this only catches a player that
// never answers. Deliberately shorter than the browser's 10 s stall watchdog.
const PREPARE_TIMEOUT_MS = 6000;
const POLL_MS = 250;
const POLL_PAUSED_MS = 500;
const DURATION_POLL_MS = 2000;
const NEAR_END_SECONDS = 1.5;
const NEAR_END_GRACE_MS = 2000;
const RESTORE_STEP_MS = 250;
const RESTORE_STEPS = 4;
// A direct seek that has not landed (or moved) this long after it was issued
// is handed to the next candidate, at the position the user asked for, rather
// than waited on for the coalescer's full deadline. The probe measured direct
// seeks at 0.76–1.6 s on H.264; the reported 4K AV1 file never finished. The
// browser plays that file, so the fallback is a real recovery, not a shrug.
const SEEK_STUCK_MS = 4000;
// A seek makes AVPlay pause and rebuffer. Re-asserting play() while that is
// true is what resumes a slow seek; doing it on every 250 ms poll is not a
// thing to do to the native player.
const PLAY_REASSERT_MS = 1000;

const ST_PLAYING = 'PLAYING';

const isHlsUrl = (url) => /\.m3u8(\?|#|$)/i.test(String(url || ''));

/** AVPlay error payloads are objects, strings, or undefined. Normalise all. */
function normalizeError(raw) {
  if (raw == null) return { name: '', code: null, message: '' };
  if (typeof raw === 'string') return { name: '', code: null, message: raw };
  const name = String(raw.name || raw.type || '');
  const code = Number.isFinite(raw.code) ? raw.code : null;
  const message = String(raw.message || raw.reason || '');
  return { name, code, message };
}

export function createAvplayBackend({
  avplay,
  tvaudiocontrol = null,
  emit = () => {},
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
  prepareTimeoutMs = PREPARE_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  // ── Session state ────────────────────────────────────────
  let gen = 0;
  let closed = true;
  let prepared = false;
  let suspended = false;
  let completed = false;
  let error = null;
  let lastFailure = null;
  let activeUrl = '';
  let startAt = 0;
  let wantPlaying = false;
  let playingLatch = false;
  let durationSec = NaN;
  let lastTime = 0;          // seconds, from the poll
  let lastTimeEmitted = -1;
  let lastDurationRead = 0;
  let nearEndSince = 0;
  let seekDegraded = false;
  // True from a seek request until a frame plays again. It tells the poll that
  // a PAUSED state is the engine rebuffering the seek, not a pause the user
  // asked for — the distinction that a frozen scene hangs on.
  let seekAwaitingPlay = false;
  let lastPlayReassert = 0;
  let cachedPosition = 0;
  let prepareTimer = null;
  let pollTimer = null;
  let lifecycleBound = false;

  // ── Mute state ───────────────────────────────────────────
  // Captured once, on the first open: the panel is restored to the state it
  // was in when this player session started, never to a guess.
  let muteCaptured = false;
  let initialMuted = false;
  let initialLevel = 100;
  let muted = false;
  // What the player asked the sitting to be, as opposed to what the TV was
  // found doing. Null until something expresses a preference; a remote-made
  // TV mute must not be overridden by the button's default.
  let desiredMuted = null;
  // Whether the app's current state differs from the state it found, which is
  // what close() restores. Not "the app muted": unmuting a TV that was muted
  // with the remote is also a change the app has to undo.
  let appMuted = false;
  const muteCapability = detectMuteCapability({ tvaudiocontrol, avplay });

  const lookup = (target, method) => {
    const obj = target === 'tvaudiocontrol' ? tvaudiocontrol : avplay;
    if (!obj || typeof obj[method] !== 'function') throw new Error(`${method} unavailable`);
    return obj[method].bind(obj);
  };

  /** Execute the calls a volumeMapping plan describes. False if any throws. */
  function runCalls(calls) {
    try {
      for (const call of calls) lookup(call.target, call.method)(...call.args);
      return true;
    } catch (e) {
      return false;
    }
  }

  function captureMuteState() {
    if (muteCaptured) return;
    muteCaptured = true;
    if (muteCapability === 'tvaudio') {
      try { initialMuted = !!tvaudiocontrol.isMute(); } catch (e) { /* assume unmuted */ }
      try {
        const v = Number(tvaudiocontrol.getVolume?.());
        if (Number.isFinite(v)) initialLevel = clampLevel(v);
      } catch (e) { /* keep 100 */ }
    } else if (muteCapability === 'setVolume') {
      try {
        const v = Number(avplay.getVolume?.());
        if (Number.isFinite(v)) initialLevel = clampLevel(v);
      } catch (e) { /* keep 100 */ }
    }
    // A TV muted with the remote stays muted, and the button must say so.
    muted = initialMuted;
    emit('volumechange');
  }

  function applyMuted(next) {
    const plan = mapMute({ capability: muteCapability, muted: next, level: initialLevel });
    if (!plan.effective) return false;
    // Remembered before the native call: the setVolume rung needs a prepared
    // session, so a mute pressed while `prepareAsync` is in flight fails here
    // and is retried by onPrepared rather than silently dropped.
    desiredMuted = plan.muted;
    if (!runCalls(plan.calls)) return false;
    muted = plan.muted;
    // Restore only what the app changed: unmuting a remote-made mute is a
    // change too, and close() has to put it back.
    appMuted = plan.muted !== initialMuted;
    // The button is owned by the player's transport, which listens for this
    // rather than assuming its own state is what the panel is doing.
    emit('volumechange');
    return true;
  }

  /** Undo a mute this app applied. Never touches a remote-made mute. */
  function releaseMute() {
    if (!appMuted) return;
    const plan = mapMuteRestore({
      capability: muteCapability,
      appMuted,
      initialMuted,
      initialLevel,
    });
    runCalls(plan.calls);
    appMuted = false;
    muted = initialMuted;
    emit('volumechange');
  }

  // ── Native helpers ───────────────────────────────────────
  const readState = () => {
    try { return avplay.getState(); } catch (e) { return null; }
  };

  const readTime = () => {
    try {
      const t = Number(avplay.getCurrentTime());
      return Number.isFinite(t) ? t / 1000 : null;
    } catch (e) {
      return null;
    }
  };

  const readDuration = () => {
    try {
      const d = Number(avplay.getDuration());
      return Number.isFinite(d) && d > 0 ? d / 1000 : NaN;
    } catch (e) {
      return NaN;
    }
  };

  const pageHidden = () => !!doc && doc.visibilityState === 'hidden';

  /** stop() then close(), tolerating every state the probe saw. */
  function closeNative() {
    if (!avplay) return;
    const state = readState();
    try {
      if (state && state !== 'IDLE') avplay.stop();
    } catch (e) {
      // stop() refuses from READY/PAUSED sometimes; close() is the real release.
    }
    try { avplay.close(); } catch (e) { /* already closed */ }
  }

  // ── Polling ──────────────────────────────────────────────
  const coalescer = createSeekCoalescer({
    seekTo: (seconds) => {
      avplay.seekTo(
        Math.max(0, Math.round(seconds * 1000)),
        () => {},
        () => {},
      );
    },
    getTime: () => lastTime,
    // Arrival is enough when the user has not asked for playback: a seek made
    // while paused must settle on the position, not wait for a PLAYING state
    // that is not coming — waiting was a burst that "degraded" after every
    // paused skim.
    isPlaying: () => !suspended && (readState() === ST_PLAYING || !wantPlaying),
    now,
    // A function, not a value: the URL is only known once `open()` has run,
    // and a value captured here would pin every HLS seek to the direct
    // window. HLS measured 1.52 s against that 1.5 s window — a retry every
    // time, each one cancelling the seek that was about to finish.
    settleMs: () => (isHlsUrl(activeUrl) ? SEEK_SETTLE_HLS_MS : SEEK_SETTLE_MS),
    // Direct play has somewhere to fall back to; a transcode does not (the
    // next candidate is the browser on the same HLS URL), so HLS keeps the
    // longer deadline and only records the degradation.
    maxWaitMs: () => (isHlsUrl(activeUrl) ? SEEK_MAX_WAIT_MS : SEEK_STUCK_MS),
    onDegraded: (target) => handleSeekDegraded(target),
  });

  /**
   * The seek burst gave up. For a direct file, hand the scene to the next
   * candidate at the position the user asked for. Leaving a frozen picture and
   * a "degraded" note is what the TV reported for the 4K AV1 scene; the
   * browser plays that file, so the fallback is the honest recovery.
   */
  function handleSeekDegraded(target) {
    seekDegraded = true;
    seekAwaitingPlay = false;
    // HLS: the probe saw seek errors that playback survived, and the browser's
    // HLS path seeks the same stream. Tearing the session down for that would
    // trade a slow seek for a stutter.
    if (isHlsUrl(activeUrl)) return;
    // The next candidate starts from this object's `currentTime`, and the live
    // clock is still frozen where the seek began. Publish the requested
    // position first, so the fallback lands where the user asked to be.
    lastTime = target;
    lastTimeEmitted = target;
    emit('timeupdate');
    fail(gen, 'seek', {
      name: 'SEEK_STUCK',
      message: 'the seek did not complete',
    });
  }

  function stopPoll() {
    if (pollTimer != null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(myGen) {
    stopPoll();
    // `error` and `completed` are states the poll itself can enter mid-tick:
    // a degraded seek calls fail() from inside coalescer.tick(), and the
    // near-end fallback calls finishEnded(). Re-arming after either would
    // poll a closed native player — and its first read would overwrite the
    // position the fallback was told to resume at with 0.
    if (gen !== myGen || closed || suspended || error || completed) return;
    const delay = wantPlaying ? POLL_MS : POLL_PAUSED_MS;
    pollTimer = setTimeout(() => tick(myGen), delay);
  }

  function finishEnded(myGen) {
    if (gen !== myGen || closed || error || completed) return;
    completed = true;
    wantPlaying = false;
    playingLatch = false;
    nearEndSince = 0;
    stopPoll();
    emit('ended');
  }

  function tick(myGen) {
    pollTimer = null;
    if (gen !== myGen || closed || suspended) return;

    const state = readState();
    const t = readTime();
    if (t != null) {
      lastTime = t;
      // `timeupdate` at the same 4 Hz the browser uses. Only on a change: a
      // paused scene repeating the same position would keep the progress UI
      // re-rendering for nothing.
      if (Math.abs(t - lastTimeEmitted) > 0.01) {
        lastTimeEmitted = t;
        emit('timeupdate');
      }
    }

    if (state === ST_PLAYING) {
      wantPlaying = true;
      seekAwaitingPlay = false;
      if (!playingLatch) {
        playingLatch = true;
        emit('playing');
      }
    } else if (state === 'PAUSED' && playingLatch) {
      if (seekAwaitingPlay && wantPlaying) {
        // AVPlay pauses while it rebuffers a seek. That is not a pause the
        // user asked for, and declaring one here is how a seek on a slow file
        // turned into a scene that never resumed: `wantPlaying` went false and
        // nothing ever asked the engine to play again. Ask again instead,
        // throttled to once a second.
        if (now() - lastPlayReassert >= PLAY_REASSERT_MS) {
          lastPlayReassert = now();
          try { avplay.play(); } catch (e) { /* the coalescer owns the verdict */ }
        }
      } else if (!seekAwaitingPlay) {
        // A pause that did not come from our pause() — the end of the stream,
        // a system pause. Report it the way the browser would.
        playingLatch = false;
        wantPlaying = false;
        emit('pause');
      }
    }

    if (prepared) {
      coalescer.tick();
      // A seek that hit its deadline fails the session synchronously from
      // inside tick(): the native player is already stopped, so nothing in
      // this poll's remaining work — a duration read, a near-end verdict, the
      // next timer — belongs to a live session. `handleSeekDegraded` has just
      // published the requested position; a later tick would read 0 from the
      // closed player and erase it before the fallback captured it.
      if (error || closed) return;
      if (now() - lastDurationRead >= DURATION_POLL_MS) {
        lastDurationRead = now();
        const d = readDuration();
        // HLS duration is not final at prepare; report it when it settles.
        if (Number.isFinite(d) && (!Number.isFinite(durationSec)
          || Math.abs(d - durationSec) > 0.5)) {
          durationSec = d;
          emit('durationchange');
        }
      }
      // `onstreamcompleted` arrived 4 s after a near-end seek in the probe, so
      // this fallback is only for the case where it never arrives at all. It
      // must not fire while a seek is in flight, or a skim to the last seconds
      // would look like the scene ending.
      if (state === ST_PLAYING && !coalescer.isSeeking()
        && Number.isFinite(durationSec) && lastTime >= durationSec - NEAR_END_SECONDS) {
        if (!nearEndSince) nearEndSince = now();
        else if (now() - nearEndSince >= NEAR_END_GRACE_MS) finishEnded(myGen);
      } else {
        nearEndSince = 0;
      }
    }

    schedulePoll(myGen);
  }

  // ── Failure ──────────────────────────────────────────────
  function fail(myGen, phase, raw) {
    if (gen !== myGen || closed || error) return;
    const info = normalizeError(raw);
    const result = classifyAvplayError({
      phase,
      name: info.name,
      code: info.code,
      message: info.message,
    });
    lastFailure = result;
    // `error` is assigned *before* the event: usePlayerMedia's guard reads it
    // and would otherwise drop a genuine failure.
    error = {
      code: result.level === 'content' ? 4 : 3,
      name: result.name || 'AVPLAY_ERROR',
      message: describeAvplayFailure(result),
      level: result.level,
      phase: result.phase,
    };
    clearTimeout(prepareTimer);
    prepareTimer = null;
    stopPoll();
    coalescer.cancel();
    playingLatch = false;
    wantPlaying = false;
    seekAwaitingPlay = false;
    prepared = false;
    closeNative();
    emit('error');
  }

  // ── Prepare / open ───────────────────────────────────────
  function onPrepared(myGen) {
    if (gen !== myGen || closed || error) return;
    clearTimeout(prepareTimer);
    prepareTimer = null;
    prepared = true;
    lastTime = 0;
    lastTimeEmitted = -1;
    lastDurationRead = now();
    durationSec = readDuration();
    // The session's own start position is queued *before* metadata is
    // announced, not after. The player's loadedmetadata handler may seek (a
    // mid-scene engine fallback resumes at the live playhead, which is not
    // `startAt`), and the coalescer is latest-wins: announcing first let this
    // stale start position overwrite the player's newer one and threw a
    // fallback back to the resume point.
    if (startAt > 0) {
      seekAwaitingPlay = true;
      lastPlayReassert = 0;
      coalescer.request(startAt);
    }
    emit('loadedmetadata');
    emit('durationchange');
    emit('canplay');
    // The TV owns a mute the app asked for; a setVolume rung can only be
    // applied once the native session exists, so this is its second chance.
    if (desiredMuted != null && desiredMuted !== muted) applyMuted(desiredMuted);
    if (pageHidden()) {
      // prepareAsync finished while the app was hidden (or the scene was
      // opened while hidden). Do not start a session behind the page: enter
      // the same suspended state the visibility hook would have entered, so
      // showing the app restores it at this position.
      suspended = true;
      cachedPosition = coalescer.pendingTarget() ?? startAt;
      try { avplay.suspend(); } catch (e) { /* restore/reopen is the recovery */ }
      return;
    }
    if (wantPlaying) startNativePlay();
    schedulePoll(myGen);
  }

  function startNativePlay() {
    wantPlaying = true;
    try {
      avplay.play();
    } catch (e) {
      // A play() that throws before the first frame is a content-level
      // failure; report it through the same path as an async one.
      fail(gen, 'play', e);
      return;
    }
    // `play` now, `playing` when the poll sees PLAYING — the same split the
    // browser makes between "asked to play" and "a frame is moving".
    emit('play');
  }

  function makeListener(myGen) {
    return {
      onbufferingstart: () => {
        if (gen !== myGen || closed) return;
        playingLatch = false;
        emit('waiting');
      },
      onbufferingprogress: () => {},
      onbufferingcomplete: () => {
        if (gen !== myGen || closed) return;
        if (wantPlaying && !playingLatch) {
          playingLatch = true;
          emit('playing');
        }
      },
      oncurrentplaytime: (ms) => {
        if (gen !== myGen || closed || suspended) return;
        const t = Number(ms);
        if (Number.isFinite(t)) lastTime = t / 1000;
      },
      onstreamcompleted: () => {
        if (gen !== myGen || closed || error) return;
        // A completion that arrives while the user's seek is in flight is
        // about the position they just left, not the one on screen. The
        // near-end fallback makes the same distinction.
        if (coalescer.isSeeking()) return;
        finishEnded(myGen);
      },
      onerror: (raw) => {
        if (gen !== myGen || closed) return;
        const phase = !prepared ? 'prepare'
          : coalescer.isSeeking() ? 'seek'
            : 'runtime';
        if (phase === 'seek') {
          // The picture is still there. Do not call the seek failed here: the
          // probe saw errors on a burst of HLS seeks that playback survived,
          // and the coalescer is what decides whether this burst is actually
          // stuck — it retries, and only then reports degraded.
          return;
        }
        fail(myGen, phase, raw);
      },
      onevent: () => {},
      onsubtitlechange: () => {},
    };
  }

  function bindLifecycle() {
    if (lifecycleBound || !doc) return;
    lifecycleBound = true;
    doc.addEventListener('visibilitychange', onVisibility);
    win?.addEventListener('pagehide', onPageHide);
  }

  function unbindLifecycle() {
    if (!lifecycleBound) return;
    lifecycleBound = false;
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('pagehide', onPageHide);
  }

  // ── App lifecycle ────────────────────────────────────────
  function suspendSession() {
    if (!prepared || closed || suspended || error) return;
    const t = readTime();
    if (t != null) lastTime = t;
    cachedPosition = lastTime;
    suspended = true;
    stopPoll();
    coalescer.cancel();
    seekAwaitingPlay = false;
    if (playingLatch) {
      playingLatch = false;
      emit('pause');
    }
    try { avplay.suspend(); } catch (e) { /* restore() is the recovery path */ }
  }

  function onVisibility() {
    if (!doc || closed) return;
    if (doc.visibilityState === 'hidden') suspendSession();
    else resumeSession();
  }

  function onPageHide() {
    // The app is going away. suspend() releases the native pipeline; there is
    // no restore to run, and close()/teardown restores the TV mute.
    suspendSession();
    wantPlaying = false;
  }

  function resumeSession() {
    if (!suspended || closed || error) return;
    suspended = false;
    const myGen = gen;
    const saved = cachedPosition;
    try {
      // Three-argument restore() threw TypeError on this panel. No-args only.
      avplay.restore();
    } catch (e) {
      reopenAtSaved(myGen, saved);
      return;
    }
    waitForRestore(myGen, saved, RESTORE_STEPS);
  }

  function waitForRestore(myGen, saved, stepsLeft) {
    if (gen !== myGen || closed || error) return;
    // Hidden again while the chain was in flight: the session is suspended,
    // not failed, and stepping on would decide "restore did not come back"
    // and reopen the stream behind the hidden page. The next show starts a
    // fresh restore.
    if (suspended) return;
    const state = readState();
    if (state === ST_PLAYING || state === 'PAUSED' || state === 'READY') {
      // The probe saw the position drift +3.0–5.4 s across a hide even with
      // suspend() called, so the cached position wins.
      const t = readTime();
      if (t != null && Math.abs(t - saved) > 1) coalescer.request(saved);
      // The poll emits `playing` when it sees PLAYING; if the user had paused
      // before hiding, restore leaves it paused and nothing is emitted.
      if (wantPlaying && !playingLatch) startNativePlay();
      schedulePoll(myGen);
      return;
    }
    if (stepsLeft <= 0) {
      reopenAtSaved(myGen, saved);
      return;
    }
    setTimeout(() => waitForRestore(myGen, saved, stepsLeft - 1), RESTORE_STEP_MS);
  }

  /** Restore did not come back: reopen the same source at the saved position. */
  function reopenAtSaved(myGen, saved) {
    if (gen !== myGen || closed) return;
    // `muted` travels with the reopen: this is a new native session, and the
    // sitting's mute choice is not something a restore failure should undo.
    open(activeUrl, { startSeconds: saved, autoplay: wantPlaying, muted: desiredMuted });
  }

  // ── Public surface ───────────────────────────────────────
  function open(url, { startSeconds = 0, autoplay = true, muted: requestedMuted = null } = {}) {
    if (!avplay) {
      error = {
        code: 3,
        name: 'AVPLAY_UNAVAILABLE',
        message: 'the TV’s player is not available',
        level: 'engine',
        phase: 'open',
      };
      emit('error');
      return;
    }
    const myGen = gen + 1;
    gen = myGen;
    closed = false;
    stopPoll();
    clearTimeout(prepareTimer);
    prepareTimer = null;
    closeNative();
    coalescer.cancel();

    prepared = false;
    suspended = false;
    completed = false;
    error = null;
    lastFailure = null;
    activeUrl = String(url || '');
    startAt = Math.max(0, Number(startSeconds) || 0);
    wantPlaying = !!autoplay;
    playingLatch = false;
    durationSec = NaN;
    lastTime = startAt;
    lastTimeEmitted = -1;
    lastDurationRead = 0;
    nearEndSince = 0;
    seekDegraded = false;
    seekAwaitingPlay = false;
    lastPlayReassert = 0;
    cachedPosition = startAt;

    desiredMuted = requestedMuted == null ? null : !!requestedMuted;
    captureMuteState();
    // Apply the sitting's mute now when the rung allows it (tvaudio works
    // before open). A setVolume rung needs the live session, so it is retried
    // in onPrepared — and a scene advance recreates the session, which is
    // exactly when the old code lost the mute.
    if (desiredMuted != null && desiredMuted !== muted) applyMuted(desiredMuted);
    bindLifecycle();

    try {
      avplay.open(activeUrl);
      avplay.setDisplayRect(0, 0, 1920, 1080);
      avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      avplay.setListener(makeListener(myGen));
      avplay.prepareAsync(
        () => onPrepared(myGen),
        (raw) => fail(myGen, 'prepare', raw),
      );
    } catch (e) {
      fail(myGen, 'open', e);
      return;
    }
    prepareTimer = setTimeout(() => {
      prepareTimer = null;
      fail(myGen, 'prepare', {
        name: 'PREPARE_TIMEOUT',
        message: 'prepare did not complete',
      });
    }, prepareTimeoutMs);
  }

  function close() {
    gen += 1;
    closed = true;
    stopPoll();
    clearTimeout(prepareTimer);
    prepareTimer = null;
    coalescer.cancel();
    closeNative();
    releaseMute();
    unbindLifecycle();
    prepared = false;
    suspended = false;
    completed = false;
    wantPlaying = false;
    playingLatch = false;
    seekAwaitingPlay = false;
    error = null;
    lastFailure = null;
    activeUrl = '';
    durationSec = NaN;
    lastTime = 0;
    cachedPosition = 0;
    desiredMuted = null;
  }

  function play() {
    if (closed || error) return Promise.resolve();
    if (suspended) {
      resumeSession();
      return Promise.resolve();
    }
    wantPlaying = true;
    if (prepared) {
      if (completed) {
        // Replaying a finished scene is a new sitting. finishEnded() stopped
        // the poll and left the completion latch set; without clearing both,
        // play would emit `play` and nothing would ever follow it — no
        // `playing`, no `timeupdate`, no second `ended`.
        completed = false;
        nearEndSince = 0;
        playingLatch = false;
        schedulePoll(gen);
      }
      if (!playingLatch) startNativePlay();
    }
    // Before prepare the request is remembered and applied in onPrepared.
    return Promise.resolve();
  }

  function pause() {
    if (closed || error) return;
    wantPlaying = false;
    seekAwaitingPlay = false;
    nearEndSince = 0;
    // A pause ends the seek burst: the user is not waiting for it any more,
    // and letting it reach its deadline would fall back to the other engine
    // for a seek nobody asked to finish.
    coalescer.cancel();
    try { avplay.pause(); } catch (e) { /* not prepared yet */ }
    if (playingLatch) {
      playingLatch = false;
      emit('pause');
    }
  }

  function requestSeek(seconds) {
    const t = Math.max(0, Number(seconds) || 0);
    if (closed || error) return;
    if (!prepared) {
      startAt = t;
      lastTime = t;
      return;
    }
    if (completed) {
      // Seeking back into a finished scene is the other way to replay it. The
      // latch kept the poll stopped, and the coalescer has to be ticked again
      // or this seek never settles.
      completed = false;
      playingLatch = false;
      schedulePoll(gen);
    }
    nearEndSince = 0;
    // A new burst is a new verdict: the previous one's "degraded" was about a
    // target the user has already moved away from.
    seekDegraded = false;
    seekAwaitingPlay = true;
    lastPlayReassert = 0;
    coalescer.request(t);
  }

  return {
    kind: 'avplay',
    capabilities: {
      mute: muteCapability,
      stats: 'reduced',
      seek: 'coalesced',
    },
    // No DOM element to attach; these exist so the facade can call them
    // unconditionally when the engine switches.
    attach() {},
    detach() {},
    open,
    close,
    play,
    pause,
    seek: requestSeek,

    /** Mute through the TV. Returns false when no capability exists. */
    setMuted(value) {
      const next = !!value;
      if (!applyMuted(next)) return false;
      return true;
    },
    getMuteCapability() { return muteCapability; },
    isSeekDegraded() { return seekDegraded; },
    getLastFailure() { return lastFailure; },

    // Same meaning as HTMLMediaElement's: "someone has asked for playback and
    // it has not been paused", not "a frame is currently moving". A buffering
    // element is not paused, and treating it as such would make the play/pause
    // button start playback it is already waiting on. A seek is not a pause
    // either — it has its own flag, which the progress reporter uses to refuse
    // crediting the jump.
    get paused() { return suspended || !wantPlaying; },
    get seeking() { return coalescer.isSeeking(); },
    get duration() { return prepared && Number.isFinite(durationSec) ? durationSec : NaN; },
    get currentTime() { return coalescer.pendingTarget() ?? lastTime; },
    set currentTime(seconds) { requestSeek(seconds); },
    get readyState() { return prepared ? 4 : 0; },
    get networkState() { return 1; },
    get muted() { return muted; },
    set muted(value) { applyMuted(!!value); },
    get volume() { return 1; },
    set volume(value) { /* the TV owns its volume; mute is the only control */ },
    get playbackRate() { return 1; },
    get error() { return error; },
    get buffered() { return emptyTimeRanges(); },
    get seekable() { return emptyTimeRanges(); },
    get videoWidth() { return 0; },
    get videoHeight() { return 0; },
    get webkitDecodedFrameCount() { return undefined; },
    get webkitDroppedFrameCount() { return undefined; },
    getVideoPlaybackQuality() { return null; },
  };
}
