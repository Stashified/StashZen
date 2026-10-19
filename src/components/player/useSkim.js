/**
 * useSkim — the ±15 s jumps and their two indicators.
 *
 * The flash is the arrow that says which way the press went; the preview is
 * the thumbnail strip over the progress bar, kept alive while the user keeps
 * pressing and hidden after a pause. Both are per-gesture, so their timers
 * live here rather than in the player shell.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SKIM_PREVIEW_HIDE_DELAY } from './constants.js';

export function useSkim({ videoRef, duration, showControls, setCurrentTime }) {
  const [skimFlash, setSkimFlash] = useState(null);
  const [skimPreviewVisible, setSkimPreviewVisible] = useState(false);
  const skimFlashTimerRef = useRef(null);
  const skimPreviewTimerRef = useRef(null);

  const skim = useCallback((delta) => {
    const v = videoRef.current;
    if (!v) return;
    // The element's duration is not always usable: a Stash MP4 transcode
    // reports none (or a short placeholder), and `(NaN || 0)` made every
    // forward skim clamp to 0 — a press that jumped *back*. The UI's own
    // timeline has the right number in exactly that case (see
    // timelineDuration), so clamp to whichever bound is real and to neither
    // when neither is.
    const elementMax = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    const timelineMax = duration > 0 ? duration : Infinity;
    const max = Math.min(elementMax, timelineMax);
    const target = Math.max(0, Math.min(max, v.currentTime + delta));
    v.currentTime = target;
    setCurrentTime(target);
    setSkimFlash(delta > 0 ? 'forward' : 'backward');
    clearTimeout(skimFlashTimerRef.current);
    skimFlashTimerRef.current = setTimeout(() => setSkimFlash(null), 600);

    // Skim-preview lifecycle: show on first skim, keep alive while
    // user keeps pressing, hide after SKIM_PREVIEW_HIDE_DELAY of inactivity.
    setSkimPreviewVisible(true);
    clearTimeout(skimPreviewTimerRef.current);
    skimPreviewTimerRef.current = setTimeout(
      () => setSkimPreviewVisible(false),
      SKIM_PREVIEW_HIDE_DELAY,
    );

    showControls();
  }, [videoRef, duration, showControls, setCurrentTime]);

  useEffect(() => () => {
    clearTimeout(skimFlashTimerRef.current);
    clearTimeout(skimPreviewTimerRef.current);
  }, []);

  return { skim, skimFlash, skimPreviewVisible };
}
