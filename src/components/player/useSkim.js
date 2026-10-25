/**
 * useSkim — the ±15 s jumps and their two indicators.
 *
 * The flash is the direction arrow; the preview is the thumbnail strip over the
 * progress bar, kept alive while the user keeps pressing and hidden after a
 * pause. Both are per-gesture, so their timers live here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SKIM_PREVIEW_HIDE_DELAY } from './constants.js';

export function useSkim({ mediaRef, duration, showControls, setCurrentTime }) {
  const [skimFlash, setSkimFlash] = useState(null);
  const [skimPreviewVisible, setSkimPreviewVisible] = useState(false);
  const skimFlashTimerRef = useRef(null);
  const skimPreviewTimerRef = useRef(null);

  const skim = useCallback((delta) => {
    const v = mediaRef.current;
    if (!v) return;
    // The element's duration is not always usable: a Stash MP4 transcode reports
    // none (or a short placeholder), and `(NaN || 0)` made a forward skim jump
    // *back* to 0. The UI timeline has the right number there, so clamp to
    // whichever bound is real, or to neither.
    const elementMax = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    const timelineMax = duration > 0 ? duration : Infinity;
    const max = Math.min(elementMax, timelineMax);
    const target = Math.max(0, Math.min(max, v.currentTime + delta));
    v.currentTime = target;
    setCurrentTime(target);
    setSkimFlash(delta > 0 ? 'forward' : 'backward');
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
  }, [mediaRef, duration, showControls, setCurrentTime]);

  useEffect(() => () => {
    clearTimeout(skimFlashTimerRef.current);
    clearTimeout(skimPreviewTimerRef.current);
  }, []);

  return { skim, skimFlash, skimPreviewVisible };
}
