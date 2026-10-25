/**
 * avplayBackend — the TV's own player, behind the media facade.
 *
 * AVPlay has no DOM node, events, buffer or seekable ranges, and draws *behind*
 * the page. This adapter presents the same small object html5Backend does, so
 * the hooks do not know which engine runs. What it cannot honestly supply
 * (buffer, seekable, readyState, resolution, frames) is left neutral and hidden
 * by `capabilities.stats`.
 *
 * Panel facts the code depends on:
 *   - `prepareAsync` refuses a codec in 110–276 ms; the 6 s watchdog is a
 *     safety net, not the normal path.
 *   - Seek callbacks are not trustworthy: a seek is settled by polling the
 *     position (`seekCoalescer`).
 *   - `restore(null, position, prepare)` throws `TypeError`; only no-arg
 *     `restore()` works, and it can lose its place by seconds, so the cached
 *     position is authoritative.
 *   - There is no `setVolume`; mute goes through the TV audio API (see
 *     volumeMapping.js).
 *
 * **Every callback carries the generation it was registered under.** A late
 * `onerror` or `onstreamcompleted` for a closed session would otherwise report
 * an error for the scene that replaced it.
 *
 * Error handling is phase-based: a refused codec and a broken engine both
 * arrive as `PLAYER_ERROR_CONNECTION_FAILED`. `lastFailure` keeps the classified
 * result so the resolver can choose between the next candidate and dropping
 * AVPlay.
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
// Refusals arrive in under 300 ms; this only catches a player that never
// answers. Shorter than the browser's 10 s stall watchdog on purpose.
const PREPARE_TIMEOUT_MS = 6000;
const POLL_MS = 250;
const POLL_PAUSED_MS = 500;
const DURATION_POLL_MS = 2000;
const NEAR_END_SECONDS = 1.5;
const NEAR_END_GRACE_MS = 2000;
const RESTORE_STEP_MS = 250;
const RESTORE_STEPS = 4;
// A direct seek not landed this long after the burst started is handed to the
// next candidate at the requested position. Direct seeks measured 0.76–1.6 s on
// H.264 and 2–3 s on the native HEVC decoder; a shorter deadline turned a rapid
// skim into an engine switch, while eight seconds still recovers a truly stuck
// seek (the 4K AV1 case). Same deadline as the coalescer's default.
const SEEK_STUCK_MS = SEEK_MAX_WAIT_MS;
// A seek makes AVPlay pause and rebuffer; re-asserting play() resumes a slow
// seek, but not on every 250 ms poll.
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
  // The stuck-seek deadline. An option so a test can reach the verdict without
  // an eight-second wait; in production it stays above the settle window.
  seekStuckMs = SEEK_STUCK_MS,
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
  // One native recovery per scene: a reopen is cheap (223–745 ms) and keeps the
  // hardware decoder, but a second failure on the same file needs the browser.
  let seekReopenUsed = false;
  // True from a seek request until a frame plays again: it tells the poll that
  // PAUSED is the engine rebuffering, not a pause the user asked for.
  let seekAwaitingPlay = false;
  let lastPlayReassert = 0;
  let cachedPosition = 0;
  let prepareTimer = null;
  let pollTimer = null;
  let lifecycleBound = false;

  // ── Mute state ───────────────────────────────────────────
  // Captured once, on the first open: close() restores the state the panel was
  // found in, never a guess.
  let muteCaptured = false;
  let initialMuted = false;
  let initialLevel = 100;
  let muted = false;
  // What the player asked for, not what the TV was found doing. Null until
  // something expresses a preference, so a remote-made mute is not overridden.
  let desiredMuted = null;
  // Whether the app's state differs from the state it found, which close()
  // restores. Not "the app muted": unmuting a remote-made mute is a change too.
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
    // session, so a mute during `prepareAsync` fails here and onPrepared
    // retries it rather than dropping it.
    desiredMuted = plan.muted;
    if (!runCalls(plan.calls)) return false;
    muted = plan.muted;
    // Restore only what the app changed: unmuting a remote-made mute is a
    // change too, and close() has to put it back.
    appMuted = plan.muted !== initialMuted;
    // The transport's button listens for this rather than assuming its own
    // state is what the panel is doing.
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
    // Arrival is enough when the user has not asked for playback: a paused seek
    // must settle on the position, not wait for a PLAYING state that never
    // comes (waiting degraded every paused skim).
    isPlaying: () => !suspended && (readState() === ST_PLAYING || !wantPlaying),
    now,
    // A function, not a value: the URL is only known once `open()` has run, and
    // HLS measured 1.52 s against the 1.5 s direct window — a pinned value
    // would retry every time, cancelling the seek about to finish.
    settleMs: () => (isHlsUrl(activeUrl) ? SEEK_SETTLE_HLS_MS : SEEK_SETTLE_MS),
    // Both direct and HLS keep the long deadline: a direct HEVC seek can take
    // 2–3 s and a fallback costs the hardware decoder. The deadline is for a
    // stuck seek, not a slow one.
    maxWaitMs: seekStuckMs,
    // The reason is load-bearing: only an arrived or progressing seek may be
    // recovered by reopening natively; a frozen one is a content failure.
    onDegraded: (target, reason) => handleSeekDegraded(target, reason),
  });

  /**
   * The seek burst gave up. Two recoveries, in order:
   *
   * 1. If the position *arrived* (or was still closing the gap) and only
   *    playback stalled, the file is seekable — reopen natively at the target,
   *    once per scene. Switching engines costs the hardware decoder.
   * 2. Otherwise hand the scene to the next candidate at that position: a
   *    frozen seek that never arrived is the 4K AV1 case this exists for.
   */
  function handleSeekDegraded(target, reason = 'stuck') {
    seekDegraded = true;
    seekAwaitingPlay = false;
    // HLS: the panel showed seek errors that playback survived, and the
    // browser's HLS path seeks the same stream. Tearing down would trade a slow
    // seek for a stutter.
    if (isHlsUrl(activeUrl)) return;
    // The next candidate starts from `currentTime`, and the live clock is still
    // frozen where the seek began. Publish the target first, so the fallback
    // lands where the user asked to be.
    lastTime = target;
    lastTimeEmitted = target;
    emit('timeupdate');
    if ((reason === 'arrived' || reason === 'progress') && !seekReopenUsed) {
      seekReopenUsed = true;
      // `open()` clears `seekDegraded`: recovery is in flight, not a verdict.
      reopenAtSaved(gen, target);
      return;
    }
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
    // `error` and `completed` can be entered mid-tick (a degraded seek calls
    // fail(), the near-end fallback calls finishEnded()). Re-arming would poll
    // a closed player, whose first read would overwrite the fallback's position
    // with 0.
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
      // `timeupdate` at the same 4 Hz the browser uses, only on a change: a
      // paused scene would otherwise re-render the progress UI for nothing.
      if (Math.abs(t - lastTimeEmitted) > 0.01) {
        lastTimeEmitted = t;
        emit('timeupdate');
      }
    }

    let reassertedThisTick = false;

    if (state === ST_PLAYING) {
      wantPlaying = true;
      seekAwaitingPlay = false;
      if (!playingLatch) {
        playingLatch = true;
        emit('playing');
      }
    } else if (state === 'PAUSED' && playingLatch) {
      if (seekAwaitingPlay && wantPlaying) {
        // AVPlay pauses while it rebuffers a seek — not a user pause. Declaring
        // one clears `wantPlaying` and nothing ever resumes the scene; ask
        // again instead, throttled to once a second.
        if (now() - lastPlayReassert >= PLAY_REASSERT_MS) {
          lastPlayReassert = now();
          reassertedThisTick = true;
          try { avplay.play(); } catch (e) { /* the coalescer owns the verdict */ }
        }
      } else if (!seekAwaitingPlay) {
        // A pause that did not come from our pause() (end of stream, a system
        // pause): report it the way the browser would.
        playingLatch = false;
        wantPlaying = false;
        emit('pause');
      }
    }

    if (prepared) {
      const wasSeeking = coalescer.isSeeking();
      coalescer.tick();
      // A stuck seek can reopen the session synchronously inside tick(). This
      // poll then belongs to the old generation — its reads would hit the new,
      // not-yet-prepared session, and it would arm a duplicate timer.
      if (gen !== myGen) return;
      // The seek just settled and the engine sits paused on the new frame,
      // waiting for the play() it already intended. Asking here instead of on
      // the next poll takes up to a second off the panel's "2–3 s" resume.
      if (wasSeeking && !reassertedThisTick && !coalescer.isSeeking()
        && seekAwaitingPlay && wantPlaying && readState() === 'PAUSED') {
        lastPlayReassert = now();
        try { avplay.play(); } catch (e) { /* the next tick retries */ }
      }
      // A seek that hit its deadline fails the session synchronously inside
      // tick(): the native player is stopped, so no remaining work belongs to a
      // live session. `handleSeekDegraded` has just published the target; a
      // later tick would read 0 and erase it before the fallback captured it.
      if (error || closed) return;
      if (now() - lastDurationRead >= DURATION_POLL_MS) {
        lastDurationRead = now();
        const d = readDuration();
        // HLS duration is not final at prepare; report it once it settles.
        if (Number.isFinite(d) && (!Number.isFinite(durationSec)
          || Math.abs(d - durationSec) > 0.5)) {
          durationSec = d;
          emit('durationchange');
        }
      }
      // `onstreamcompleted` arrived 4 s after a near-end seek, so this only
      // covers the case where it never arrives. It must not fire during a seek,
      // or a skim to the last seconds would look like the scene ending.
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
    // `error` is assigned *before* the event: usePlayerMedia's guard reads it,
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
    // The start position is queued *before* metadata is announced. The
    // loadedmetadata handler may seek (a mid-scene fallback resumes at the live
    // playhead), and the coalescer is latest-wins: announcing first let this
    // stale position overwrite the newer one and reset the fallback.
    if (startAt > 0) {
      seekAwaitingPlay = true;
      lastPlayReassert = 0;
      coalescer.request(startAt);
    }
    emit('loadedmetadata');
    emit('durationchange');
    emit('canplay');
    // The setVolume rung can only be applied once the native session exists;
    // this is its second chance.
    if (desiredMuted != null && desiredMuted !== muted) applyMuted(desiredMuted);
    if (pageHidden()) {
      // Prepare finished while the app was hidden. Do not start a session
      // behind the page: enter the suspended state the visibility hook would
      // have, so showing the app restores it at this position.
      suspended = true;
      cachedPosition = coalescer.pendingTarget() ?? startAt;
      // As in suspendSession: no mute of ours survives into a hidden page. The
      // intent stays and is re-applied on the way back.
      releaseMute();
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
      // failure: report it through the async path.
      fail(gen, 'play', e);
      return;
    }
    // `play` now, `playing` when the poll sees PLAYING — the browser's split
    // between "asked to play" and "a frame is moving".
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
        // A completion during a seek is about the position just left, not the
        // one on screen; the near-end fallback makes the same distinction.
        if (coalescer.isSeeking()) return;
        finishEnded(myGen);
      },
      onerror: (raw) => {
        if (gen !== myGen || closed) return;
        const phase = !prepared ? 'prepare'
          : coalescer.isSeeking() ? 'seek'
            : 'runtime';
        if (phase === 'seek') {
          // The picture is still there. Errors on a burst of HLS seeks were
          // survived by playback, so the coalescer decides whether the burst is
          // stuck: it retries, and only then reports degraded.
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
    // The app is going away: suspend() releases the native pipeline. There is
    // no restore to run; close()/teardown restores the TV mute.
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
    // Hidden again mid-chain: the session is suspended, not failed, and
    // stepping on would reopen the stream behind the hidden page. The next show
    // starts a fresh restore.
    if (suspended) return;
    const state = readState();
    if (state === ST_PLAYING || state === 'PAUSED' || state === 'READY') {
      // The position drifted +3.0–5.4 s across a hide even with suspend()
      // called, so the cached position wins.
      const t = readTime();
      if (t != null && Math.abs(t - saved) > 1) coalescer.request(saved);
      // The poll emits `playing` when it sees PLAYING; a scene paused before
      // hiding stays paused and emits nothing.
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
    // `muted` travels with the reopen: this is a new native session, and a
    // restore failure must not undo the sitting's mute choice.
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
    // A new scene gets its own native recovery. The reopen passes the same URL,
    // so it does not reset the one-per-scene guard.
    if (String(url || '') !== activeUrl) seekReopenUsed = false;
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
    // setVolume is session-local: a new session starts at the panel's level, so
    // the remembered mute no longer describes it, and onPrepared would skip its
    // retry and leave the new scene audible while the button said muted.
    // tvaudiocontrol is panel-wide, so its value stays.
    if (muteCapability === 'setVolume') muted = initialMuted;
    // Apply the mute now only on the rung independent of the native session:
    // tvaudiocontrol works before `open()`. A setVolume call before the session
    // exists cannot belong to it, so that rung waits for onPrepared.
    if (muteCapability === 'tvaudio'
        && desiredMuted != null && desiredMuted !== muted) {
      applyMuted(desiredMuted);
    }
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
    seekReopenUsed = false;
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
        // Replaying a finished scene is a new sitting. finishEnded() stopped the
        // poll and left the latch set; without clearing both, play would emit
        // `play` and nothing would follow — no `playing`, no `ended`.
        completed = false;
        nearEndSince = 0;
        playingLatch = false;
        schedulePoll(gen);
      }
      if (!playingLatch) startNativePlay();
    }
    // Before prepare, the request is remembered and applied in onPrepared.
    return Promise.resolve();
  }

  function pause() {
    if (closed || error) return;
    wantPlaying = false;
    seekAwaitingPlay = false;
    nearEndSince = 0;
    // A pause ends the seek burst: letting it reach its deadline would fall
    // back to the other engine for a seek nobody is waiting for.
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
      // Seeking back into a finished scene is another way to replay it. The
      // poll is stopped, and the coalescer must be ticked again or this seek
      // never settles.
      completed = false;
      playingLatch = false;
      schedulePoll(gen);
    }
    nearEndSince = 0;
    // A new burst is a new verdict: the last "degraded" was about a target the
    // user has moved away from.
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
    // unconditionally on an engine switch.
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

    // Same meaning as HTMLMediaElement's: "asked for playback and not paused",
    // not "a frame is moving". Treating buffering as paused would make the
    // play/pause button start playback it is already waiting on. A seek has its
    // own flag, which the progress reporter uses to refuse crediting the jump.
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
