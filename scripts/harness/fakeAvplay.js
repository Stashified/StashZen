/**
 * fakeAvplay — a stand-in for `window.webapis.avplay` (and the TV audio API)
 * in the headless harness.
 *
 * The harness can prove structure — that no `<video>` exists when AVPlay opens,
 * that a refusal falls back and keeps its position, that a hide suspends and a
 * return restores — but it cannot decode anything, and the real engine only
 * exists on the TV. So the contract the backend code depends on is written
 * down here, in the same calls the Phase 0 probe measured, and the driver
 * asserts what the app did with them.
 *
 * What is deliberately faithful:
 *   - `getCurrentTime`/`getDuration` are milliseconds, `getState` is a string.
 *   - `prepareAsync` answers through callbacks, never a promise.
 *   - `restore()` is no-args; the three-argument form throws, exactly as this
 *     panel's WebIDL did.
 *   - A refused codec arrives as `PLAYER_ERROR_CONNECTION_FAILED` after a
 *     short delay — the ambiguity the error classifier exists for.
 *
 * The clock is advanced by a real interval *and* by `advance(ms)`, so a test
 * can be deterministic without sleeping for a scene's length.
 */

const PLAYER_ERROR = {
  CONNECTION_FAILED: 'PLAYER_ERROR_CONNECTION_FAILED',
  NOT_SUPPORTED_FILE: 'PLAYER_ERROR_NOT_SUPPORTED_FILE',
  INVALID_STATE: 'PLAYER_ERROR_INVALID_STATE',
  TIMEOUT: 'PLAYER_ERROR_TIMEOUT',
};

export function installFakeAvplay({
  win = typeof window !== 'undefined' ? window : globalThis,
  modes = [],
  prepareDelayMs = 30,
  durationMs = 600000,
  startState = 'IDLE',
  noTvAudio = false,
  withVolume = false,
} = {}) {
  const mode = new Set(modes);
  let state = startState;
  let positionMs = 0;
  let duration = durationMs;
  let completed = false;
  let listener = null;
  let timer = null;
  let lastTick = 0;
  // While a `slowSeek` is running the engine is decoding the new position:
  // the clock is frozen, exactly as the TV's is. It is what the coalescer
  // must wait for instead of re-issuing the seek.
  let seekHoldUntil = 0;
  let openUrl = '';

  const calls = {
    open: [],
    openAttempts: [],
    close: 0,
    stop: 0,
    play: 0,
    pause: 0,
    seek: [],
    suspend: 0,
    restore: [],
    preventDefault: 0,
    displayMethod: [],
    displayRect: [],
    setVolume: [],
    videoPresentAtOpen: [],
    prepareCalls: 0,
    errors: [],
  };

  function fire(type) {
    try { listener?.[type]?.(); } catch (e) { /* a listener must not kill the fake */ }
  }

  function tick() {
    if (state !== 'PLAYING' || completed) {
      // A paused or suspended engine's clock is stopped, so the wait must not
      // be credited to the next playing tick. The probe measured this: the
      // position does not advance while hidden (and `restore()` can even drift
      // it, which is why the backend re-asserts the cached position).
      lastTick = 0;
      return;
    }
    const t = Date.now();
    if (t < seekHoldUntil) {
      // A seek in progress: the position does not move until it lands, and
      // the held time must not be credited to the next playing tick.
      lastTick = t;
      return;
    }
    const delta = lastTick ? t - lastTick : 0;
    lastTick = t;
    positionMs += delta;
    try { listener?.oncurrentplaytime?.(positionMs); } catch (e) { /* ignore */ }
    if (positionMs >= duration) {
      positionMs = duration;
      complete();
    }
  }

  function complete() {
    if (completed) return;
    completed = true;
    state = 'PAUSED';
    fire('onstreamcompleted');
  }

  const avplay = {
    getVersion: () => 'fake-7.0',

    open(url) {
      // An attempt that throws is still an attempt: the failure modes assert on
      // how many times the app asked, which is not the same as how many
      // sessions were opened.
      calls.openAttempts.push(String(url));
      calls.videoPresentAtOpen.push(!!(typeof document !== 'undefined'
        && document.querySelector('video')));
      if (mode.has('failOpen')) throw new Error('open failed');
      openUrl = String(url);
      calls.open.push(openUrl);
      state = 'OPENED';
      positionMs = 0;
      completed = false;
      // A new session does not inherit the last one's seek hold.
      seekHoldUntil = 0;
    },

    setListener(next) { listener = next; },

    setDisplayRect(x, y, w, h) { calls.displayRect.push([x, y, w, h]); },
    setDisplayMethod(m) { calls.displayMethod.push(m); },

    prepareAsync(onSuccess, onError) {
      calls.prepareCalls += 1;
      state = 'PREPARING';
      setTimeout(() => {
        // `failDirect` is the panel-generation case: the original file is
        // refused, the HLS transcode is not. Models an older TV that plays
        // fewer containers than the panel the probe measured.
        const directRefused = mode.has('failPrepare')
          || (mode.has('failDirect') && !/\.(m3u8|mp4|webm)(\?|$)/i.test(openUrl));
        if (directRefused) {
          state = 'IDLE';
          const err = { name: PLAYER_ERROR.CONNECTION_FAILED, message: 'codec refused' };
          calls.errors.push(err);
          try { onError?.(err); } catch (e) { /* ignore */ }
          return;
        }
        state = 'READY';
        try { onSuccess?.(); } catch (e) { /* ignore */ }
      }, mode.has('slowPrepare') ? 4500 : prepareDelayMs);
    },

    play() {
      if (mode.has('failPlay')) {
        const err = { name: PLAYER_ERROR.NOT_SUPPORTED_FILE };
        calls.errors.push(err);
        throw err;
      }
      calls.play += 1;
      if (state === 'READY' || state === 'PAUSED') {
        state = 'PLAYING';
        lastTick = Date.now();
        if (!timer) timer = setInterval(tick, 100);
      }
    },

    pause() {
      calls.pause += 1;
      if (state === 'PLAYING') state = 'PAUSED';
    },

    stop() {
      calls.stop += 1;
      state = 'IDLE';
    },

    close() {
      calls.close += 1;
      state = 'IDLE';
    },

    seekTo(ms, onSuccess) {
      calls.seek.push(Math.round(ms));
      if (mode.has('seekThrow')) throw new Error('seek refused');
      if (mode.has('seekError')) {
        setTimeout(() => { fire('onerror'); }, 20);
        return;
      }
      const target = Math.max(0, Math.round(ms));
      if (mode.has('slowSeek')) {
        // The seek takes longer than one settle window while the clock stays
        // frozen. The player must wait for it, not re-issue it every window.
        const wait = Number(win.__fakeSlowSeekMs) || 3000;
        seekHoldUntil = Date.now() + wait;
        setTimeout(() => {
          seekHoldUntil = 0;
          positionMs = target;
          lastTick = Date.now();
          try { onSuccess?.(); } catch (e) { /* ignore */ }
        }, wait);
        return;
      }
      if (mode.has('pauseOnSeek')) {
        // The engine pauses to rebuffer a seek: the position has landed, but
        // nothing plays again until play() is called. A player that reads
        // PAUSED as a user pause never asks, and the scene stays frozen.
        positionMs = target;
        state = 'PAUSED';
        lastTick = 0;
        setTimeout(() => { try { onSuccess?.(); } catch (e) { /* ignore */ } }, 10);
        return;
      }
      if (mode.has('stuckSeek')) {
        // Accepted and never finished: the clock freezes where it was and no
        // callback ever fires. The player has to decide what to do about it.
        seekHoldUntil = Infinity;
        return;
      }
      positionMs = target;
      setTimeout(() => onSuccess?.(), 10);
    },

    getState: () => state,
    getCurrentTime: () => Math.round(positionMs),
    getDuration: () => duration,

    suspend() {
      calls.suspend += 1;
      if (state === 'PLAYING') state = 'SUSPENDED';
    },

    restore(...args) {
      calls.restore.push(args);
      // Tizen 9.0's WebIDL rejected this signature; keep the failure visible.
      if (args.length) throw new TypeError('restore() takes no arguments');
      if (state === 'SUSPENDED') {
        state = mode.has('restoreStaysPaused') ? 'PAUSED' : 'PLAYING';
      }
    },
  };

  if (withVolume) {
    let level = 30;
    avplay.getVolume = () => level;
    avplay.setVolume = (v) => { calls.setVolume.push(v); level = v; };
  }

  // ── TV audio ──────────────────────────────────────────────
  let tvMuted = !!win.__fakeTvMutedInitially;
  let tvVolume = 13;
  const tvCalls = { setMute: [], setVolume: [] };
  const tvaudiocontrol = {
    setMute(value) { tvCalls.setMute.push(!!value); tvMuted = !!value; },
    isMute() { return tvMuted; },
    getVolume() { return tvVolume; },
    setVolume(v) { tvCalls.setVolume.push(v); tvVolume = v; },
    setVolumeChangeListener() {},
  };

  // ── Installation ─────────────────────────────────────────
  const priorWebapis = win.webapis;
  const priorTizen = win.tizen;
  win.webapis = { ...(priorWebapis || {}), avplay };
  if (!noTvAudio) {
    win.tizen = { ...(priorTizen || {}), tvaudiocontrol };
  } else {
    win.tizen = priorTizen;
  }

  return {
    avplay,
    tvaudiocontrol: noTvAudio ? null : tvaudiocontrol,
    calls,
    tvCalls,
    mode,
    get state() { return state; },
    setState(next) { state = next; },
    get positionMs() { return positionMs; },
    set positionMs(ms) { positionMs = ms; },
    setDuration(ms) { duration = ms; },
    advance(ms) {
      if (state !== 'PLAYING') return positionMs;
      positionMs = Math.min(duration, positionMs + ms);
      try { listener?.oncurrentplaytime?.(positionMs); } catch (e) { /* ignore */ }
      if (positionMs >= duration) complete();
      return positionMs;
    },
    buffer() { fire('onbufferingstart'); },
    bufferDone() { fire('onbufferingcomplete'); },
    fireError(name = PLAYER_ERROR.CONNECTION_FAILED, code = -7) {
      const err = { name, code, message: 'fake error' };
      calls.errors.push(err);
      try { listener?.onerror?.(err); } catch (e) { /* ignore */ }
    },
    complete,
    uninstall() {
      if (timer) clearInterval(timer);
      timer = null;
      win.webapis = priorWebapis;
      win.tizen = priorTizen;
    },
  };
}
