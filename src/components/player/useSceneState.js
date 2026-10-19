/**
 * useSceneState — what Stash knows about the scene on screen.
 *
 * One small query per scene, and the per-scene reset that has to go with it:
 * without the reset the value fetched for the previous scene would be the one
 * that seeks this one. The latches it clears belong to Phase 4b's resume and
 * media hooks and are passed in rather than owned here, so the resets still
 * happen in one commit and in the same order as before the split.
 */

import { useCallback, useEffect, useState } from 'react';
import { fetchSceneState } from '../../utils/videoService.js';
import { mergeMarkers } from './markerUtils.js';

export function useSceneState({
  video,
  progress,
  startSeekedRef,
  pendingLiveResumeRef,
  setLoadError,
}) {
  // Prefer the freshly-fetched value over whatever the grid had cached.
  const [liveResumeTime, setLiveResumeTime] = useState(null);
  // The current scene's markers, sorted, from the same request that fetched
  // the resume point. Drives the progress-bar ticks and the rail's two marker
  // buttons.
  const [markers, setMarkers] = useState([]);
  // `null` until the user answers; reset per scene by the effect below.
  const [resumeChoice, setResumeChoice] = useState(null);

  const addMarkers = useCallback((incoming) => {
    setMarkers(prev => mergeMarkers(prev, incoming));
  }, []);

  // Refresh resume_time from Stash. The cached grid data may be stale
  // (position was saved on a previous close, but the grid wasn't
  // refetched). One small query per scene — and per *scene* is the point:
  // without the reset below the value fetched for the previous scene would
  // be the one that seeks this one.
  useEffect(() => {
    // Per-scene reset: the resume value, the auto-seek latch, a load error
    // and the marker ticks all describe the scene that was on screen a
    // moment ago.
    setLiveResumeTime(null);
    setLoadError(null);
    setMarkers([]);
    startSeekedRef.current = false;
    pendingLiveResumeRef.current = 0;
    progress.setScene(video?.id ?? null);
    // The answer belongs to the scene it was given for. Carried over, a queue
    // advance would skip the question for the next scene — and worse, "start
    // from the beginning" would follow the user down the queue.
    setResumeChoice(null);
    if (!video?.id) return;
    let cancelled = false;
    fetchSceneState(video.id)
      .then(state => {
        if (cancelled || !state) return;
        setLiveResumeTime(state.resume_time);
        // Union rather than replace: a marker created while this was in flight
        // belongs to this scene and is not in the response. See mergeMarkers.
        addMarkers(state.markers || []);
      })
      .catch(e => {
        // The scene's own state did not arrive, so its resume point, counts
        // and markers are unknown — not absent. Reported through the same
        // chip as a failed write, because it is the same condition: this app
        // is not reaching Stash. Swallowed, it looked exactly like a scene
        // that had never been played.
        if (cancelled) return;
        progress.reportError(e);
      });
    return () => { cancelled = true; };
  }, [video?.id, addMarkers, progress, startSeekedRef, pendingLiveResumeRef, setLoadError]);

  return { liveResumeTime, markers, setMarkers, addMarkers, resumeChoice, setResumeChoice };
}
