/**
 * seekCoalescer — latest-wins seeks with a settle rule, retries, and a
 * degradation signal.
 *
 * AVPlay has no native seek queue. Issuing a `seekTo` for every D-pad press
 * during a skim means issuing while the previous seek is still in flight, and
 * the Phase 0 probe measured three errors in a burst of rapid HLS seeks when
 * the player did exactly that. The browser tolerated it; the native engine
 * should not be relied on to.
 *
 * The contract the player depends on:
 *
 * - **Latest wins.** A new target replaces the pending one; the in-flight
 *   seek's own target is abandoned, not queued behind. Five rapid +15 s
 *   presses must land 75 s ahead, which also requires the facade's
 *   `currentTime` getter to return the pending target (it reads the getter
 *   straight after the setter — see useSkim.js).
 * - **Settle on position, not on a callback.** AVPlay has no seek-complete
 *   event. A seek is done when `getTime()` is within tolerance of the target
 *   *and* playback is running, or when the settle window expires.
 * - **Never re-issue a seek that is being worked on.** A position at the
 *   target with the engine still buffering is nearly done, and a position
 *   frozen where the seek started means the engine is scanning. Calling
 *   `seekTo` again throws that work away and starts over, which is how a slow
 *   seek fails to ever finish — the reported "seek never finishes" on a 4K
 *   AV1 file. The window is extended instead, up to the overall deadline
 *   (SEEK_MAX_WAIT_MS unless the caller decides per source).
 * - **Retry only a seek that was ignored.** A position that ran on past its
 *   starting point while still far from the target means the engine never
 *   took the request; that one is re-issued, twice, then degraded.
 * - **Degrade eventually.** Three throws, an ignored seek past its retries, or
 *   SEEK_MAX_WAIT_MS of waiting turn degraded and onDegraded fires once for
 *   that burst. Degraded is not fatal: the spike saw HLS seek errors while
 *   playback continued.
 *
 * This module owns no timers. The backend's 250 ms poll calls `tick()`, which
 * makes the whole thing deterministic under test.
 */

export const SEEK_TOLERANCE_SECONDS = 1.5;
export const SEEK_SETTLE_MS = 1500;
// HLS seeks measured 1.52 s; the longer window avoids retrying a seek that is
// merely slow.
export const SEEK_SETTLE_HLS_MS = 2500;
export const SEEK_MAX_RETRIES = 2;
// The seeker will keep waiting for a position that is not moving for this long
// in total before calling the burst failed. A 4K AV1 seek can take several
// seconds of decode; the probe's 763 ms was measured on H.264 1080p. This is
// the default (and the AVPlay backend's HLS deadline); a direct file gets a
// shorter one, because its failure has somewhere to fall back to.
export const SEEK_MAX_WAIT_MS = 8000;
// Movement smaller than this is playback noise or a stale sample, not evidence
// that the seek was ignored — the engine is still working on it.
export const SEEK_MOVED_SECONDS = 0.5;

export function createSeekCoalescer({
  seekTo,
  getTime,
  isPlaying = () => true,
  now = () => Date.now(),
  onDegraded = () => {},
  settleMs = SEEK_SETTLE_MS,
  tolerance = SEEK_TOLERANCE_SECONDS,
  maxRetries = SEEK_MAX_RETRIES,
  maxWaitMs = SEEK_MAX_WAIT_MS,
}) {
  let active = false;
  let target = null;
  let issuedAt = 0;
  let issuedPosition = null;
  let burstStartedAt = 0;
  let retries = 0;
  let degraded = false;

  function settle() {
    active = false;
    target = null;
    retries = 0;
    issuedPosition = null;
  }

  const readTime = () => {
    try {
      const t = Number(getTime());
      return Number.isFinite(t) ? t : null;
    } catch (e) {
      return null;
    }
  };

  // The window can be a number or a function. A function is what the AVPlay
  // backend needs: its source is not known when the coalescer is constructed,
  // so a number captured here would silently pin every HLS seek to the direct
  // window. HLS measured 1.52 s against a 1.5 s window — always a retry.
  const settleWindow = () => {
    const v = typeof settleMs === 'function' ? settleMs() : settleMs;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : SEEK_SETTLE_MS;
  };

  // The overall deadline can be decided per tick too: the AVPlay backend gives
  // a direct file a shorter one than a transcode, because a direct seek that
  // has not landed by then is handed to the other engine rather than waited on
  // for twice as long.
  const maxWaitWindow = () => {
    const v = typeof maxWaitMs === 'function' ? maxWaitMs() : maxWaitMs;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : SEEK_MAX_WAIT_MS;
  };

  // Returns false when the native call throws.
  function issue(next) {
    target = next;
    issuedAt = now();
    // Where the engine was when the seek was asked for: the reference that
    // tells "still working" (position frozen) from "ignored" (playback ran on).
    issuedPosition = readTime();
    try {
      seekTo(next);
      return true;
    } catch (e) {
      return false;
    }
  }

  function degrade(failedTarget) {
    settle();
    degraded = true;
    try { onDegraded(failedTarget); } catch (e) { /* observer must not break the player */ }
  }

  return {
    /**
     * Ask for a new position. Finite, clamped at zero; anything else is
     * ignored. A request during an in-flight seek replaces it and resets the
     * retry count — the latest target has not had its own chance yet.
     */
    request(seconds) {
      const n = Number(seconds);
      if (!Number.isFinite(n)) return;
      const next = Math.max(0, n);
      active = true;
      degraded = false;
      retries = 0;
      burstStartedAt = now();
      if (issue(next)) return;

      // The native call threw before the seek ever started. Three throws in a
      // row is the documented degradation point (1 attempt + 2 retries).
      for (let i = 0; i < maxRetries; i++) {
        if (issue(next)) return;
      }
      degrade(next);
    },

    /**
     * Advance the settle machine. Call from the engine poll.
     */
    tick() {
      if (!active) return;
      let t;
      try { t = Number(getTime()); } catch (e) { /* unreadable position */ }

      const close = Number.isFinite(t) && Math.abs(t - target) <= tolerance;
      // If the engine cannot say whether it is playing, assume it is: a seek
      // that has visibly reached its target should settle rather than retry.
      let playing = true;
      try { playing = !!isPlaying(); } catch (e) { /* keep the assumption */ }

      if (close && playing) {
        settle();
        return;
      }

      if (now() - issuedAt < settleWindow()) return;

      const expired = now() - burstStartedAt >= maxWaitWindow();

      // The position is at the target and only the engine's playing state is
      // behind (it is buffering the new position). Re-issuing the seek now
      // restarts that fetch and can loop forever on a slow seek, so wait.
      if (close) {
        if (expired) {
          degrade(target);
          return;
        }
        issuedAt = now();
        return;
      }

      // A position that has not moved from where the seek started is evidence
      // that the engine is still working on it — a 4K AV1 seek takes seconds.
      // Restarting it here was the "seek never finishes" failure: every
      // window cancelled the seek that was about to land.
      const readable = Number.isFinite(t);
      const moved = readable && issuedPosition != null
        && Math.abs(t - issuedPosition) > SEEK_MOVED_SECONDS;
      if (!moved) {
        if (expired) {
          degrade(target);
          return;
        }
        issuedAt = now();
        return;
      }

      // Playback ran on regardless of the request, so the engine never took
      // it. Re-issue, within the retry budget and the same overall deadline.
      if (retries < maxRetries && !expired) {
        retries += 1;
        if (!issue(target)) degrade(target);
        return;
      }
      degrade(target);
    },

    /** Abandon any pending seek — source change, pause, teardown. */
    cancel() {
      settle();
    },

    /** The target the getter should report instead of the live position. */
    pendingTarget() {
      return active ? target : null;
    },

    isSeeking() {
      return active;
    },

    /** True after the current burst gave up; cleared by the next request. */
    isDegraded() {
      return degraded;
    },
  };
}
