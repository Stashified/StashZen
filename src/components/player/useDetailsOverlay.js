/**
 * useDetailsOverlay: the scene detail page over the player, its stream
 * readout, and the two ways the page hands playback back.
 *
 * Unlike the marker form, closing the page does not resume what it
 * interrupted: the page is a destination the user chose to stop at, so playing
 * again is their press, the page's own Play.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function useDetailsOverlay({ mediaRef, progress, showControls, setCurrentTime }) {
  // A boolean: there is nothing per-open to remember, it always describes the
  // scene currently loaded, i.e. the element's own state.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The stream readout. Off on open, kept across a queue advance: it describes
  // whatever is playing, not the session that started it.
  const [statsOpen, setStatsOpen] = useState(false);
  const detailsOpenerRef = useRef(null);
  const detailsRestoreTimerRef = useRef(null);

  /**
   * The ⓘ button: the detail page for whatever is playing, over the top of it.
   *
   * Paused while up and **not** resumed on close, unlike the marker form: the
   * page is a destination full of controls that write to the scene, so closing
   * restores the state the user left and the page's own Play restarts it.
   */
  const openDetails = useCallback(() => {
    const v = mediaRef.current;
    if (!v) return;
    detailsOpenerRef.current = document.activeElement;
    if (!v.paused) v.pause();
    setDetailsOpen(true);
    // The rail is counting down behind the page, so re-arm it now rather than
    // leaving the user to come back to a bare video.
    showControls();
  }, [mediaRef, showControls]);

  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    // Deferred because the page's controls are still mounted here; their
    // unmount would steal the focus back.
    clearTimeout(detailsRestoreTimerRef.current);
    detailsRestoreTimerRef.current = window.setTimeout(() => {
      const opener = detailsOpenerRef.current;
      if (opener && document.contains(opener)) opener.focus();
    }, 0);
    showControls();
  }, [showControls]);

  /**
   * The playback-info readout, toggled from the rail. The cursor stays on the
   * button, so keeping the rail up is all this must do: the panel has no
   * controls, and looking at it need not dim the video.
   */
  const toggleStats = useCallback(() => {
    setStatsOpen(open => !open);
    showControls();
  }, [showControls]);

  /**
   * The page's Play, while the page is over the player. Resumes the loaded
   * scene rather than opening a new one: the app's own Play would rebuild the
   * queue as a single scene and restart from zero, losing the position and the
   * listing.
   */
  const playFromDetails = useCallback(() => {
    closeDetails();
    const v = mediaRef.current;
    if (v?.paused) v.play().catch(() => {});
  }, [mediaRef, closeDetails]);

  /**
   * A marker chip, while the page is over the player: seek there and play, on
   * the loaded element, so the queue and current scene survive. The overlay
   * opened from a pause, so resuming is part of the gesture.
   *
   * The reporter's clock moves with the jump; otherwise the next save would
   * bill the whole seek as watch time.
   */
  const playAtFromDetails = useCallback((seconds) => {
    closeDetails();
    const v = mediaRef.current;
    if (!v) return;
    // The clock records where the *element* actually is, so it moves only when
    // the seek took: a non-seekable stream must not be given a position it
    // never reached, and the save must not bill the gap.
    let moved = true;
    try { v.currentTime = seconds; } catch (e) { moved = false; }
    if (moved) {
      progress.seek(seconds);
      setCurrentTime(seconds);
    }
    v.play().catch(() => {});
  }, [mediaRef, closeDetails, progress, setCurrentTime]);

  useEffect(() => () => clearTimeout(detailsRestoreTimerRef.current), []);

  return {
    detailsOpen,
    statsOpen,
    openDetails,
    closeDetails,
    toggleStats,
    playFromDetails,
    playAtFromDetails,
  };
}
