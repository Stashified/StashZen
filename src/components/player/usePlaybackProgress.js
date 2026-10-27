/**
 * usePlaybackProgress: the player's writes to Stash, wired to React.
 *
 * The accounting lives in `progressReporter.js` (no React, unit-tested
 * directly). This hook owns the page-level parts: sync chip state, the unmount
 * latch, and the saves not driven by a media event, visibility, pagehide and
 * the 30 s interval. Media handlers call `progress`; `useSceneState` supplies
 * the scene id and reports a failed read through the same chip.
 */

import { useEffect, useRef, useState } from 'react';
import { saveSceneActivity, addScenePlay } from '../../utils/videoService.js';
import { RESUME_SAVE_INTERVAL_MS } from './constants.js';
import { createProgressReporter } from './progressReporter.js';

export function usePlaybackProgress({ video, mediaRef, onActivityChange }) {
  // `idle | saving | saved | failed`, surfaced as the time row's chip. `failed`
  // is the only way the user can learn nothing is reaching the server.
  const [syncState, setSyncState] = useState('idle');

  // The player reports completion so the shelf can prune the card in place. A
  // ref because App's handler is new each render, and depending on it would
  // re-key the periodic save every time.
  const activityChangeRef = useRef(onActivityChange);
  useEffect(() => { activityChangeRef.current = onActivityChange; });

  // A lazy `useState` initializer, not `useMemo`: React may discard memoised
  // values, and this object owns the unmount latch and pending saves, so a new
  // instance would lose both. StrictMode's double call leaves one harmless
  // unreferenced instance.
  const [progress] = useState(() => createProgressReporter({
    save: saveSceneActivity,
    addPlay: addScenePlay,
    onSync: setSyncState,
    onCompleted: (id) => activityChangeRef.current?.(id, { resumeTime: 0 }),
  }));

  // Re-armed, not just latched: StrictMode mounts, tears down and remounts, and
  // a cleanup-only latch would stay false for the component's life, silently
  // stopping every save from being acknowledged in development.
  useEffect(() => {
    progress.mount();
    return () => progress.dispose();
  }, [progress]);

  // Clear the "Saved" chip shortly after it appears: a status that never goes
  // away reads as a label.
  useEffect(() => {
    if (syncState !== 'saved') return;
    const t = setTimeout(() => setSyncState('idle'), 2000);
    return () => clearTimeout(t);
  }, [syncState]);

  /**
   * Teardown saves for the exits React cannot see.
   *
   * The save effect's cleanup covers Back and a queue advance. Leaving the app:
   * Home, a source change, standby, a relaunch, unmounts nothing, and on Tizen
   * `visibilitychange` is the signal that fires.
   *
   * Best-effort: the write is a `fetch` carrying the `ApiKey` header, so
   * `sendBeacon` (no headers) is unusable. `beforeunload` is not wired up, where
   * it fires it fires with `pagehide`, and the second call is a wasted request
   * behind the same <2s guard.
   */
  useEffect(() => {
    const id = video?.id;
    if (!id) return;

    const onPageHide = () => progress.save(id);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') progress.save(id);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [video?.id, progress]);

  // Periodic and event-driven save of resume_time. Every RESUME_SAVE_INTERVAL_MS
  // while playing, on pause and on teardown, which covers Back-to-close and a
  // queue advance, since the effect re-keys on the scene's id.
  useEffect(() => {
    const v = mediaRef.current;
    const id = video?.id;
    if (!v || !id) return;

    // The cursor belongs to the scene loading now: without the reset the first
    // save would report the outgoing position. The reset itself saves nothing:
    // the <2s guard compares 0 against 0.
    progress.resetScene();

    const onPause = () => progress.save(id);

    v.addEventListener('pause', onPause);

    const saveTimer = setInterval(() => {
      if (!v.paused) progress.save(id);
    }, RESUME_SAVE_INTERVAL_MS);

    return () => {
      v.removeEventListener('pause', onPause);
      clearInterval(saveTimer);
      // Final save on teardown (covers Back-to-close)
      progress.save(id);
    };
  }, [video?.id, mediaRef, progress]);

  return { progress, syncState };
}
