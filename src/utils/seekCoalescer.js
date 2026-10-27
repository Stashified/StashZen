/**
 * seekCoalescer, latest-wins seeks with a settle rule, retries, and a
 * degradation signal.
 *
 * AVPlay has no native seek queue. Issuing `seekTo` for every D-pad press while
 * the last is still in flight caused three errors in a burst of rapid HLS seeks
 * in the Phase 0 probe; the browser tolerated it, the native engine should not.
 *
 * The contract the player depends on:
 *
 * - **Latest wins.** A new target replaces the pending one; the in-flight
 *   seek's target is abandoned, not queued. Five rapid +15 s presses must land
 *   75 s ahead, which needs the facade's `currentTime` getter to return the
 *   pending target (see useSkim.js).
 * - **Settle on position, not a callback.** AVPlay has no seek-complete event:
 *   a seek is done when `getTime()` is within tolerance *and* playing, or when
 *   the settle window expires.
 * - **Arrival without playback is its own verdict.** The position at the target
 *   with the engine not playing means the seek finished and the resume did not;
 *   it degrades after 2.5 s, not the full deadline, so a wedged decoder is
 *   recovered while the user is still looking at the new frame.
 * - **Never re-issue a seek being worked on.** A frozen position means the
 *   engine is scanning; calling `seekTo` again throws that work away and is how
 *   a slow seek never finishes. Extend the window instead, up to the overall
 *   deadline (maxWaitMs, possibly chosen per source).
 * - **Retry only an ignored seek**, the position ran on *away from* the
 *   target. Movement that shrinks the distance is progress (a forward seek
 *   plays on while scanning). An ignored seek is re-issued twice, then
 *   degraded.
 * - **Re-issue a frozen seek only when the burst overlapped itself**, and only
 *   once: a rapid burst can leave an engine paused at the pre-burst position,
 *   having lost the final target. A single frozen seek is scanning and is left
 *   alone.
 * - **Wait longer for a seek closing the gap.** Movement toward the target at
 *   the deadline earns one extension per burst.
 * - **Degrade eventually.** Three throws, an ignored seek past its retries, or
 *   maxWaitMs waiting turn degraded and fire onDegraded once per burst with a
 *   reason (see `degrade`). Degraded is not fatal: playback can continue.
 *
 * This module owns no timers; the backend's 250 ms poll calls `tick()`, which
 * keeps it deterministic under test.
 */

export const SEEK_TOLERANCE_SECONDS = 1.5;
// A direct HEVC seek on this panel was measured at 2–3 s. The 1.5 s window
// turned every slower backward skim into a retry, and the retry aborted the
// seek it waited for. The window is when the coalescer may *suspect* the engine
// ignored the request, not a deadline.
export const SEEK_SETTLE_MS = 3000;
// HLS seeks measured 1.52 s; this window avoids retrying a merely slow seek.
// Direct play has its own longer window: the native decoder can hold a HEVC
// seek for seconds where browser-backed HLS was measured faster.
export const SEEK_SETTLE_HLS_MS = 2500;
export const SEEK_MAX_RETRIES = 2;
// A position at the target that never starts playing is not a slow seek: the
// seek itself is done. Waiting for the burst deadline kept the panel frozen
// for ~8 s before recovery; this is enough to tell the two apart.
export const SEEK_ARRIVED_MS = 2500;
// Total time the seeker waits on a non-moving position before the burst gives
// up. A 4K AV1 seek takes several seconds of decode (the probe's 763 ms was
// H.264 1080p). The AVPlay backend uses it for every source: a direct failure
// is recovered natively, not handed to another engine.
export const SEEK_MAX_WAIT_MS = 8000;
// Movement smaller than this is playback noise or a stale sample, not evidence
// that the seek was ignored, the engine is still working on it.
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
  arrivedMs = SEEK_ARRIVED_MS,
}) {
  let active = false;
  let target = null;
  let issuedAt = 0;
  let issuedPosition = null;
  // Distance to travel at issue time: the difference between a slow seek and
  // an ignored one; null when the position was unreadable at issue.
  let issuedDistance = null;
  let burstStartedAt = 0;
  // Requests in the current burst. More than one means the native seeks
  // overlapped, a different failure shape from a single slow seek.
  let burstRequests = 0;
  // Whether a progressing burst has already been given its one extension.
  let deadlineExtended = false;
  // Whether an overlapped frozen burst has already been re-issued once.
  let burstReissued = false;
  let retries = 0;
  let degraded = false;
  // When the position first sat at the target without playback starting.
  let closeSince = 0;

  function settle() {
    active = false;
    target = null;
    retries = 0;
    burstRequests = 0;
    deadlineExtended = false;
    issuedPosition = null;
    issuedDistance = null;
    closeSince = 0;
  }

  const readTime = () => {
    try {
      const t = Number(getTime());
      return Number.isFinite(t) ? t : null;
    } catch (e) {
      return null;
    }
  };

  // Allowed to be a function: the AVPlay backend does not know its source at
  // construction, and a captured number would pin every HLS seek to the direct
  // window. HLS measured 1.52 s against 1.5 s, always a retry.
  const settleWindow = () => {
    const v = typeof settleMs === 'function' ? settleMs() : settleMs;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : SEEK_SETTLE_MS;
  };

  // Also per tick, so a caller can vary it by source.
  const maxWaitWindow = () => {
    const v = typeof maxWaitMs === 'function' ? maxWaitMs() : maxWaitMs;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : SEEK_MAX_WAIT_MS;
  };

  const arrivedWindow = () => {
    const v = typeof arrivedMs === 'function' ? arrivedMs() : arrivedMs;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : SEEK_ARRIVED_MS;
  };

  // Returns false when the native call throws.
  function issue(next) {
    target = next;
    issuedAt = now();
    closeSince = 0;
    // Where the engine was at issue: tells "still working" (frozen) from
    // "ignored" (playback ran on *away* from the target).
    issuedPosition = readTime();
    issuedDistance = issuedPosition == null ? null : Math.abs(issuedPosition - next);
    try {
      seekTo(next);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * End the burst as failed. The reason is for the engine, not the user:
   *   stuck     position never moved (a seek the engine never took)
   *   ignored   playback ran on away from the target, retries spent
   *   arrived   position reached the target but playback never resumed
   *   progress  still closing the gap at the second deadline
   *   threw     the native call keeps throwing
   * A caller decides the recovery. The AVPlay backend reopens the native
   * session at the target and never changes engines over a failed seek.
   */
  function degrade(failedTarget, reason = 'stuck') {
    settle();
    degraded = true;
    try { onDegraded(failedTarget, reason); } catch (e) { /* observer must not break the player */ }
  }

  return {
    /**
     * Ask for a new position. Finite, clamped at zero; anything else is
     * ignored. A request during an in-flight seek replaces it and resets the
     * retry count, the latest target has had no chance yet.
     */
    request(seconds) {
      const n = Number(seconds);
      if (!Number.isFinite(n)) return;
      const next = Math.max(0, n);
      if (!active) {
        burstRequests = 0;
        deadlineExtended = false;
      }
      active = true;
      degraded = false;
      retries = 0;
      closeSince = 0;
      burstRequests += 1;
      burstReissued = false;
      burstStartedAt = now();
      if (issue(next)) return;

      // The native call threw before the seek ever started. Three throws in a
      // row is the documented degradation point (1 attempt + 2 retries).
      for (let i = 0; i < maxRetries; i++) {
        if (issue(next)) return;
      }
      degrade(next, 'threw');
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

      // Arrival without playback is checked on every poll, not once per settle
      // window: the seek is over, only its resume is missing, and 8 s of
      // frozen picture is what the panel showed before recovery began.
      if (close) {
        if (!closeSince) closeSince = now();
        else if (now() - closeSince >= arrivedWindow()) {
          // The seek itself is done; it is playback that did not resume. The
          // engine gets a reason so it can recover without changing engines.
          degrade(target, 'arrived');
          return;
        }
      } else {
        closeSince = 0;
      }

      // The overall deadline is not debounced by the settle window: waiting for
      // the window to re-elapse after it passed added up to one more window
      // (3 s) of dead air before recovery (a 4 s deadline fired at 6.2 s).
      const expired = now() - burstStartedAt >= maxWaitWindow();
      if (!expired && now() - issuedAt < settleWindow()) return;

      // The position is at the target and only the engine's playing state is
      // behind (it is buffering the new position). Re-issuing the seek now
      // restarts that fetch and can loop forever on a slow seek, so wait.
      if (close) {
        if (expired) {
          degrade(target, 'arrived');
          return;
        }
        issuedAt = now();
        return;
      }

      // A position frozen at the start is the engine still working, a 4K AV1
      // seek takes seconds. Restarting it here makes a slow seek never finish.
      const readable = Number.isFinite(t);
      const moved = readable && issuedPosition != null
        && Math.abs(t - issuedPosition) > SEEK_MOVED_SECONDS;
      // Movement alone is not a verdict. A forward seek plays on while the
      // engine scans, shrinking the distance; only movement *away from* the
      // target says the request was not taken.
      const progressing = issuedDistance != null && readable
        && Math.abs(t - target) <= issuedDistance - SEEK_MOVED_SECONDS;
      if (!moved || progressing) {
        if (expired) {
          // A seek that is still closing the gap is making progress, not
          // failing. Give it one more window before calling the burst failed.
          if (progressing && !deadlineExtended) {
            deadlineExtended = true;
            burstStartedAt = now();
            issuedAt = now();
            return;
          }
          degrade(target, progressing ? 'progress' : 'stuck');
          return;
        }
        // A frozen position is normally the engine scanning: leave it. But an
        // overlapped burst that left the engine at the pre-burst position lost
        // the final target; one fresh re-issue recovers it. A slow single seek
        // never qualifies (burstRequests > 1 is the tell, not time).
        if (!moved && burstRequests > 1 && !burstReissued) {
          burstReissued = true;
          if (!issue(target)) degrade(target, 'threw');
          return;
        }
        issuedAt = now();
        return;
      }

      // Playback ran on regardless of the request, so the engine never took
      // it. Re-issue, within the retry budget and the same overall deadline.
      if (retries < maxRetries && !expired) {
        retries += 1;
        if (!issue(target)) degrade(target, 'threw');
        return;
      }
      degrade(target, 'ignored');
    },

    /** Abandon any pending seek, source change, pause, teardown. */
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
