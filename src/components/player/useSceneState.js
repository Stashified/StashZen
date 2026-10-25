/**
 * useSceneState — what Stash knows about the scene on screen: one small query
 * per scene plus the per-scene reset. Without the reset, the previous scene's
 * value would seek this one. The latches it clears belong to the resume and
 * media hooks and are passed in, so all resets happen in one commit.
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
  // Prefer the freshly-fetched value over the grid's cache.
  const [liveResumeTime, setLiveResumeTime] = useState(null);
  // The current scene's markers, sorted, from the same request that fetched the
  // resume point. Drives the progress ticks and the rail's two marker buttons.
  const [markers, setMarkers] = useState([]);
  // `null` until the user answers; reset per scene by the effect below.
  const [resumeChoice, setResumeChoice] = useState(null);

  const addMarkers = useCallback((incoming) => {
    setMarkers(prev => mergeMarkers(prev, incoming));
  }, []);

  // Refresh resume_time from Stash: the cached grid data may be stale. One
  // small query per scene — per *scene* is the point: without the reset below,
  // the previous scene's value would seek this one.
  useEffect(() => {
    // Per-scene reset: the resume value, auto-seek latch, load error and marker
    // ticks all describe the scene that was on screen a moment ago.
    setLiveResumeTime(null);
    setLoadError(null);
    setMarkers([]);
    startSeekedRef.current = false;
    pendingLiveResumeRef.current = 0;
    progress.setScene(video?.id ?? null);
    // The answer belongs to the scene it was given for: carried over, a queue
    // advance would skip the question, and "start from the beginning" would
    // follow the user down the queue.
    setResumeChoice(null);
    if (!video?.id) return;
    let cancelled = false;
    fetchSceneState(video.id)
      .then(state => {
        if (cancelled || !state) return;
        setLiveResumeTime(state.resume_time);
        // Union, not replace: a marker created while this was in flight belongs
        // to this scene and is not in the response. See mergeMarkers.
        addMarkers(state.markers || []);
      })
      .catch(e => {
        // The scene's state did not arrive, so its resume point, counts and
        // markers are unknown, not absent. Reported through the write chip:
        // same condition, this app is not reaching Stash. Swallowed, it looked
        // exactly like a scene never played.
        if (cancelled) return;
        progress.reportError(e);
      });
    return () => { cancelled = true; };
  }, [video?.id, addMarkers, progress, startSeekedRef, pendingLiveResumeRef, setLoadError]);

  return { liveResumeTime, markers, setMarkers, addMarkers, resumeChoice, setResumeChoice };
}
