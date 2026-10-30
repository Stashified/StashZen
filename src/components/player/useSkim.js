/**
 * useSkim: the accelerating skim jumps and their two indicators.
 *
 * The flash is the direction arrow; the preview is the thumbnail strip over the
 * progress bar, kept alive while the user keeps pressing and hidden after a
 * pause. Both are per-gesture, so their timers live here.
 *
 * Repeated presses in one direction climb `SKIM_STEPS`, one rung per
 * `SKIM_RUNG_HOLD_MS` held, so getting far into a scene is a few presses
 * rather than a dozen. The upper rungs scale with the scene's duration, so a
 * long file is not four times slower to cross than a short one; the first rung
 * stays 5 s. A fixed `seekStep` setting replaces the ladder with the chosen
 * distance; the coalescing and repeat throttle are unchanged.
 *
 * A held skim is one gesture, and it reaches the engine as one seek. Each press
 * used to assign `currentTime`, and in the browser every assignment aborts the
 * previous range request: the panel heard that as heavy disk reads. The first
 * press of a run is issued at once so a discrete tap keeps its latency; the
 * rest wait for quiet and only the final target is sent.
 *
 * Between those presses the *displayed* position glides, so the bar and the
 * sprite preview move continuously instead of stepping three times a second.
 * Only the clock moves; the element still waits for the gesture to end.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SKIM_STEPS, SKIM_ACCEL_RESET_MS, SKIM_RUNG_HOLD_MS, SKIM_REPEAT_MS,
  SKIM_GLIDE_MS, SKIM_PREVIEW_HIDE_DELAY,
  SKIM_SCALE_REFERENCE_S, SKIM_SCALE_MAX,
} from './constants.js';

/**
 * Which rung a press lands on, and when that rung started. Same direction
 * within the window continues; a turn or a pause goes back to the first and
 * restarts its dwell. `since` is carried so key repeat cannot climb two rungs
 * inside one dwell.
 */
export function nextSkimRung({ rung, since, direction, lastDirection, lastAt, now }) {
  const continuing = direction === lastDirection && now - lastAt <= SKIM_ACCEL_RESET_MS;
  if (!continuing) return { rung: 0, since: now };
  if (now - since < SKIM_RUNG_HOLD_MS) return { rung, since };
  const next = Math.min(rung + 1, SKIM_STEPS.length - 1);
  return { rung: next, since: next === rung ? since : now };
}

/**
 * The step a rung is worth on this file. Rung 0 is always a 5 s tap; the rest
 * scale with duration so a two-hour scene crosses in about the same hold time
 * as a half-hour one. An unknown duration keeps the base ladder.
 */
export function skimStepFor(rung, duration) {
  const base = SKIM_STEPS[rung] ?? SKIM_STEPS[0];
  if (rung === 0 || !(duration > 0)) return base;
  const scale = Math.min(
    SKIM_SCALE_MAX,
    Math.max(1, duration / SKIM_SCALE_REFERENCE_S),
  );
  return scale === 1 ? base : Math.round(base * scale);
}

// Quiet after the last press before the gesture's final seek is sent. The
// actual wait follows the observed press gap (with a margin), capped at the run
// window: a remote repeating every 500 ms would otherwise fire this timer in
// the gap and still seek once per press.
const SKIM_SEEK_QUIET_MS = 400;

export function useSkim({
  mediaRef, duration, showControls, setCurrentTime, mediaKey, skimPendingRef,
  seekStep = 'adaptive',
}) {
  const [skimFlash, setSkimFlash] = useState(null);
  const [skimPreviewVisible, setSkimPreviewVisible] = useState(false);
  const skimFlashTimerRef = useRef(null);
  const skimPreviewTimerRef = useRef(null);
  const seekTimerRef = useRef(null);
  // The target of the current gesture that has not reached the engine yet. The
  // UI follows it, so the ladder and the sprite preview keep moving.
  const pendingSeekRef = useRef(null);
  const rungRef = useRef(0);
  const rungSinceRef = useRef(0);
  const lastDirectionRef = useRef(0);
  const lastAtRef = useRef(0);
  const lastSeekAtRef = useRef(0);
  // Gap between the last two presses of the run, for the quiet window.
  const lastGapRef = useRef(0);
  // The timeline position on screen. It runs ahead of the element while a
  // glide is in flight; the element only moves on the merged seek.
  const displayRef = useRef(null);
  const glideRafRef = useRef(null);

  const cancelGlide = useCallback(() => {
    if (glideRafRef.current != null) {
      cancelAnimationFrame(glideRafRef.current);
      glideRafRef.current = null;
    }
  }, []);

  /**
   * Move the displayed position to `to` over one repeat interval. Each held
   * press lands a step, so animating between them is what turns the three
   * steps a second into continuous motion.
   */
  const glideTo = useCallback((to) => {
    const from = displayRef.current ?? to;
    cancelGlide();
    if (from === to || typeof requestAnimationFrame !== 'function') {
      displayRef.current = to;
      setCurrentTime(to);
      return;
    }
    let start = null;
    let paintedAt = 0;
    const step = (ts) => {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / SKIM_GLIDE_MS);
      // ~30 fps is smooth for a scrubber and leaves the TV CPU its headroom;
      // the last frame always paints so the display lands exactly on target.
      if (p === 1 || ts - paintedAt >= 33) {
        displayRef.current = from + (to - from) * p;
        setCurrentTime(displayRef.current);
        paintedAt = ts;
      }
      if (p < 1) {
        glideRafRef.current = requestAnimationFrame(step);
      } else {
        glideRafRef.current = null;
        displayRef.current = to;
      }
    };
    glideRafRef.current = requestAnimationFrame(step);
  }, [cancelGlide, setCurrentTime]);

  // The argument's sign is all that matters: the ladder owns the distance, so
  // every caller (keys, rail buttons) gets the same acceleration.
  const skim = useCallback((delta, isRepeat = false) => {
    const v = mediaRef.current;
    if (!v) return;
    const direction = delta > 0 ? 1 : -1;
    const now = Date.now();
    // A held key repeats far faster than a person can tap. Drop only repeats,
    // and keep the run alive so the ladder still climbs.
    if (isRepeat && now - lastSeekAtRef.current < SKIM_REPEAT_MS) {
      lastAtRef.current = now;
      return;
    }
    // Whether this press continues the same run, decided before the timestamp
    // moves. A run is the gesture: the first press seeks now, the rest merge.
    const continuing = lastSeekAtRef.current > 0
      && now - lastSeekAtRef.current <= SKIM_ACCEL_RESET_MS;
    lastGapRef.current = continuing ? now - lastSeekAtRef.current : 0;
    lastSeekAtRef.current = now;
    // A fixed step is every press the same distance, so the ladder does not
    // run; the rung refs are left alone and start fresh if the setting is
    // later changed back.
    const fixed = typeof seekStep === 'number' && seekStep > 0;
    let seconds = fixed ? seekStep : 0;
    if (!fixed) {
      const state = nextSkimRung({
        rung: rungRef.current,
        since: rungSinceRef.current,
        direction,
        lastDirection: lastDirectionRef.current,
        lastAt: lastAtRef.current,
        now,
      });
      const rung = state.rung;
      rungRef.current = rung;
      rungSinceRef.current = state.since;
      seconds = skimStepFor(rung, duration);
    }
    lastDirectionRef.current = direction;
    lastAtRef.current = now;

    // The element's duration is not always usable: a Stash MP4 transcode reports
    // none (or a short placeholder), and `(NaN || 0)` made a forward skim jump
    // *back* to 0. The UI timeline has the right number there, so clamp to
    // whichever bound is real, or to neither.
    const elementMax = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    const timelineMax = duration > 0 ? duration : Infinity;
    const max = Math.min(elementMax, timelineMax);
    // The base is the gesture's unsent target when there is one. The engine's
    // own currentTime still reports the pre-gesture position in the browser.
    const base = pendingSeekRef.current ?? v.currentTime;
    const target = Math.max(0, Math.min(max, base + direction * seconds));

    if (!continuing) {
      cancelGlide();
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
      pendingSeekRef.current = null;
      if (skimPendingRef) skimPendingRef.current = false;
      v.currentTime = target;
      displayRef.current = target;
      setCurrentTime(target);
    } else {
      pendingSeekRef.current = target;
      // Stop the element's own `timeupdate` from moving the timeline while the
      // target is unsent, or the bar yoyos back to the frame on screen.
      if (skimPendingRef) skimPendingRef.current = true;
      const quiet = lastGapRef.current
        ? Math.min(SKIM_ACCEL_RESET_MS, Math.max(
          SKIM_SEEK_QUIET_MS, Math.round(lastGapRef.current * 1.5),
        ))
        : SKIM_SEEK_QUIET_MS;
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = setTimeout(() => {
        seekTimerRef.current = null;
        const at = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (skimPendingRef) skimPendingRef.current = false;
        const media = mediaRef.current;
        if (at == null || !media) return;
        media.currentTime = at;
      }, quiet);
      glideTo(target);
    }
    setSkimFlash({ direction: direction > 0 ? 'forward' : 'backward', seconds });
    clearTimeout(skimFlashTimerRef.current);
    skimFlashTimerRef.current = setTimeout(() => setSkimFlash(null), 600);

    // Show on first skim, keep alive while the user presses, hide after
    // SKIM_PREVIEW_HIDE_DELAY of inactivity.
    setSkimPreviewVisible(true);
    clearTimeout(skimPreviewTimerRef.current);
    skimPreviewTimerRef.current = setTimeout(
      () => setSkimPreviewVisible(false),
      SKIM_PREVIEW_HIDE_DELAY,
    );

    showControls();
  }, [
    mediaRef, duration, showControls, setCurrentTime, skimPendingRef, seekStep,
    cancelGlide, glideTo,
  ]);

  // A pending gesture target belongs to the source it was computed for.
  useEffect(() => {
    pendingSeekRef.current = null;
    if (skimPendingRef) skimPendingRef.current = false;
    clearTimeout(seekTimerRef.current);
    seekTimerRef.current = null;
    cancelGlide();
    displayRef.current = null;
  }, [mediaKey, skimPendingRef, cancelGlide]);

  useEffect(() => () => {
    clearTimeout(skimFlashTimerRef.current);
    clearTimeout(skimPreviewTimerRef.current);
    clearTimeout(seekTimerRef.current);
    cancelGlide();
    if (skimPendingRef) skimPendingRef.current = false;
  }, [skimPendingRef, cancelGlide]);

  return { skim, skimFlash, skimPreviewVisible };
}
