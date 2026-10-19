/**
 * useMarkerOverlay — the add-marker form and its confirmation.
 *
 * Opening the form pauses (a scene running on behind it would make the marker
 * land somewhere other than where the user was looking) and remembers what
 * had focus; closing restores it after the form's own chips have unmounted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function useMarkerOverlay({ videoRef, addMarkers, showControls }) {
  // `{ seconds, wasPlaying }` while the add-marker form is up, null otherwise.
  // The whole object is per-open data, so it lives in state rather than being
  // spread across refs — and holding it here is also what keeps the resume
  // decision honest when the form is dismissed without saving.
  const [markerModal, setMarkerModal] = useState(null);
  const [markerNotice, setMarkerNotice] = useState(null);
  const markerOpenerRef = useRef(null);
  const markerRestoreTimerRef = useRef(null);

  const openMarkerModal = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // Captured, not assumed to be the rail. Restoring whatever had focus is the
    // same convention the app's other overlays use, and here it means Back out
    // of the form is one press rather than a hunt for where the cursor went.
    markerOpenerRef.current = document.activeElement;
    const wasPlaying = !v.paused;
    // Paused for as long as the form is up. The timestamp is captured once at
    // open, so a scene running on behind the form would not move the number —
    // but it would make the marker land somewhere other than where the user
    // was looking when they pressed the button, and it is hostile besides.
    if (wasPlaying) v.pause();
    setMarkerModal({ seconds: v.currentTime || 0, wasPlaying });
  }, [videoRef]);

  const closeMarkerModal = useCallback(() => {
    // Resume only if the form interrupted playback. A scene that was already
    // paused when the form opened must stay paused: the form is not a play
    // button, and quietly starting a scene the user had stopped is worse than
    // leaving them to press play.
    if (markerModal?.wasPlaying) {
      const v = videoRef.current;
      if (v?.paused) v.play().catch(() => {});
    }
    setMarkerModal(null);
    // Deferred, because the form's own chips are still mounted at this point
    // and their unmount is what would take the focus back off whatever this
    // restores it to. Held so the unmount can cancel it.
    clearTimeout(markerRestoreTimerRef.current);
    markerRestoreTimerRef.current = window.setTimeout(() => {
      const opener = markerOpenerRef.current;
      if (opener && document.contains(opener)) opener.focus();
    }, 0);
    // The controls have been counting down behind the form, so re-arm them
    // rather than leaving the user with a bare video and no rail.
    showControls();
  }, [videoRef, markerModal?.wasPlaying, showControls]);

  // Closing the form is the only path that both writes and reports, so the
  // confirmation is attached to the create rather than to the close.
  const handleMarkerCreated = useCallback((created) => {
    addMarkers([{ id: created.id, seconds: created.seconds, primaryTag: created.primaryTag }]);
    setMarkerNotice(
      created.primaryTag?.name ? `Marker added · ${created.primaryTag.name}` : 'Marker added',
    );
  }, [addMarkers]);

  useEffect(() => {
    if (!markerNotice) return;
    const t = setTimeout(() => setMarkerNotice(null), 2500);
    return () => clearTimeout(t);
  }, [markerNotice]);

  useEffect(() => () => clearTimeout(markerRestoreTimerRef.current), []);

  return {
    markerModal,
    markerNotice,
    openMarkerModal,
    closeMarkerModal,
    handleMarkerCreated,
  };
}
