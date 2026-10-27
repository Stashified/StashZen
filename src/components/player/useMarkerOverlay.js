/**
 * useMarkerOverlay: the add-marker form and its confirmation.
 *
 * Opening pauses (a scene running on would make the marker land elsewhere) and
 * remembers focus; closing restores it after the form's chips have unmounted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function useMarkerOverlay({ mediaRef, addMarkers, showControls }) {
  // `{ seconds, wasPlaying }` while the form is up, null otherwise. Per-open
  // data in state, which also keeps the resume decision honest when dismissed.
  const [markerModal, setMarkerModal] = useState(null);
  const [markerNotice, setMarkerNotice] = useState(null);
  const markerOpenerRef = useRef(null);
  const markerRestoreTimerRef = useRef(null);

  const openMarkerModal = useCallback(() => {
    const v = mediaRef.current;
    if (!v) return;
    // Captured, not assumed to be the rail: Back out of the form should be one
    // press rather than a hunt for where the cursor went.
    markerOpenerRef.current = document.activeElement;
    const wasPlaying = !v.paused;
    // Paused while the form is up: the timestamp is fixed at open, but a scene
    // running on would make the marker land somewhere else entirely.
    if (wasPlaying) v.pause();
    setMarkerModal({ seconds: v.currentTime || 0, wasPlaying });
  }, [mediaRef]);

  const closeMarkerModal = useCallback(() => {
    // Resume only if the form interrupted playback: a scene already paused must
    // stay paused, the form is not a play button.
    if (markerModal?.wasPlaying) {
      const v = mediaRef.current;
      if (v?.paused) v.play().catch(() => {});
    }
    setMarkerModal(null);
    // Deferred: the form's chips are still mounted, and their unmount would
    // steal the restored focus. Held so the unmount can cancel it.
    clearTimeout(markerRestoreTimerRef.current);
    markerRestoreTimerRef.current = window.setTimeout(() => {
      const opener = markerOpenerRef.current;
      if (opener && document.contains(opener)) opener.focus();
    }, 0);
    // The controls counted down behind the form; re-arm them rather than
    // leaving a bare video.
    showControls();
  }, [mediaRef, markerModal?.wasPlaying, showControls]);

  // Closing is the only path that writes and reports, so the confirmation is
  // attached to the create rather than the close.
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
