/**
 * useDetailsOverlay — the scene detail page over the player, its stream
 * readout, and the two ways the page hands playback back.
 *
 * Unlike the marker form, closing the page does not resume what it
 * interrupted. The form is a detour; the page is a destination the user chose
 * to stop at, so closing restores the state they left and starting again is
 * their press to make — the page's own Play.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function useDetailsOverlay({ mediaRef, progress, showControls, setCurrentTime }) {
  // A boolean rather than an object because there is nothing per-open to
  // remember: it always describes the scene currently loaded, which is the
  // video element's own state.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The stream readout. Off on open and kept across a queue advance, because
  // it describes whatever is playing rather than the session that started it.
  const [statsOpen, setStatsOpen] = useState(false);
  const detailsOpenerRef = useRef(null);
  const detailsRestoreTimerRef = useRef(null);

  /**
   * The ⓘ button: the detail page for whatever is playing, over the top of it.
   *
   * Paused for as long as it is up, and **not** resumed on close — unlike the
   * marker form, which resumes what it interrupted. The difference is what the
   * overlay is for. The form is a detour: it takes a timestamp, hands the scene
   * straight back, and nobody wants to have missed a minute of it. The detail
   * page is a destination the user chose to stop at, and it is full of controls
   * that write to the scene — so closing it restores the state they left, and
   * starting the scene again is their press to make. The page's own Play is
   * that press.
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
    // Deferred for the same reason the form's is: the page's own controls are
    // still mounted at this point, and their unmount is what would take the
    // focus back off whatever this restores it to.
    clearTimeout(detailsRestoreTimerRef.current);
    detailsRestoreTimerRef.current = window.setTimeout(() => {
      const opener = detailsOpenerRef.current;
      if (opener && document.contains(opener)) opener.focus();
    }, 0);
    showControls();
  }, [showControls]);

  /**
   * The playback-info readout, toggled from the rail.
   *
   * The cursor stays on the button, so keeping the rail up is all this has to
   * do: the panel has no controls, and looking at it is not a reason to throw
   * the user back onto a bare video.
   */
  const toggleStats = useCallback(() => {
    setStatsOpen(open => !open);
    showControls();
  }, [showControls]);

  /**
   * The page's Play, while the page is over the player.
   *
   * Resumes the scene already loaded rather than opening a new one. Going
   * through the app's own Play would rebuild the queue as a single scene and
   * restart from zero — throwing away both the position the user paused at and
   * the listing the queue was walking.
   */
  const playFromDetails = useCallback(() => {
    closeDetails();
    const v = mediaRef.current;
    if (v?.paused) v.play().catch(() => {});
  }, [mediaRef, closeDetails]);

  /**
   * A marker chip, while the page is over the player.
   *
   * The same gesture as a marker on the app-level detail page — seek there
   * and play — but on the element already loaded, so the queue and the
   * current scene survive. Without this handler the chips were focus stops
   * that consumed OK and did nothing: the row rendered, the ring moved, and
   * the playhead stayed put. The overlay is opened from a pause
   * (`openDetails` pauses), so resuming is part of the gesture.
   *
   * The reporter's clock moves with the jump. `timeupdate` credits watch time
   * from the delta between ticks, and leaving it behind would bill the
   * whole seek as playback on the save that follows.
   */
  const playAtFromDetails = useCallback((seconds) => {
    closeDetails();
    const v = mediaRef.current;
    if (!v) return;
    // The clock records where the *element* actually is, so it moves only
    // when the seek took. A non-seekable stream must not have a position
    // written for it that the element never reached — `timeupdate` will report
    // the real one, and the save must not bill the difference as watched.
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
