/**
 * usePlaybackProgress — the player's writes to Stash, wired to React.
 *
 * The accounting lives in `progressReporter.js`, which has no React in it and
 * is unit-tested directly. This hook owns only what is about the page rather
 * than the element: the sync chip's state, the unmount latch, and the three
 * moments a save is not driven by a media event (visibility, pagehide, and the
 * 30 s interval). The media event handlers call the returned `progress` object
 * — `tick`, `seek`, `complete`, `countPlay` — and `useSceneState` supplies the
 * scene id and reports a failed read through the same chip.
 */

import { useEffect, useRef, useState } from 'react';
import { saveSceneActivity, addScenePlay } from '../../utils/videoService.js';
import { RESUME_SAVE_INTERVAL_MS } from './constants.js';
import { createProgressReporter } from './progressReporter.js';

export function usePlaybackProgress({ video, videoRef, onActivityChange }) {
  // `idle | saving | saved | failed`. Surfaced as the chip in the time row; the
  // failure state is the only way a user of this app can find out that nothing
  // is reaching the server. The reporter calls this through `onSync`.
  const [syncState, setSyncState] = useState('idle');

  // The player reports completion so the shelf can prune the card in place. A
  // ref because App's handler is a new function each render, and putting it in
  // the reporter's effect-like dependency set would re-key the periodic save on
  // every render.
  const activityChangeRef = useRef(onActivityChange);
  useEffect(() => { activityChangeRef.current = onActivityChange; });

  // A lazy `useState` initializer, not `useMemo`. React is allowed to discard
  // memoised values, and this object owns the unmount latch and any pending
  // save — a new instance would silently lose both. Constructing it is a pure
  // function call (`mount()` below does the arming), so StrictMode's double
  // invocation in development leaves one harmless unreferenced instance.
  const [progress] = useState(() => createProgressReporter({
    save: saveSceneActivity,
    addPlay: addScenePlay,
    onSync: setSyncState,
    onCompleted: (id) => activityChangeRef.current?.(id, { resumeTime: 0 }),
  }));

  // Re-armed, not just latched: StrictMode mounts, tears its effects down and
  // mounts them again, and a cleanup-only latch would leave the flag false for
  // the life of the component. In development that silently stops every save
  // from being acknowledged (and every later one from draining its pending
  // delta); production builds run this once and are unaffected.
  useEffect(() => {
    progress.mount();
    return () => progress.dispose();
  }, [progress]);

  // Clear the "Saved" chip a moment after it appears. A status that never goes
  // away stops reading as a status and starts reading as a label.
  useEffect(() => {
    if (syncState !== 'saved') return;
    const t = setTimeout(() => setSyncState('idle'), 2000);
    return () => clearTimeout(t);
  }, [syncState]);

  /**
   * Teardown saves for the exits React cannot see.
   *
   * The save effect's cleanup covers Back and a queue advance, because both
   * unmount or re-key this component. Leaving the app — Home, a source change,
   * the TV's own standby, a relaunch — unmounts nothing at all, and on Tizen
   * `visibilitychange` is the signal that actually fires.
   *
   * Best-effort by nature, and worth saying why: this is an ordinary `fetch`
   * carrying the `ApiKey` header, so `sendBeacon` — which would survive the page
   * being torn down — is unusable, since it cannot set a header. `beforeunload`
   * is deliberately not wired up alongside `pagehide`; where it does fire it
   * fires together with `pagehide`, and the second call would be a wasted
   * request behind the same <2s guard.
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

  // Periodic and event-driven save of resume_time back to Stash.
  // Runs every RESUME_SAVE_INTERVAL_MS while playing, plus on pause
  // and on teardown — which covers both Back-to-close and an advance to the
  // next scene, since the queue re-keys this effect on the scene's id.
  useEffect(() => {
    const v = videoRef.current;
    const id = video?.id;
    if (!v || !id) return;

    // The cursor belongs to the scene loading now. Without the reset the
    // new scene's first save would report the outgoing one's position; with
    // it, the reset saves nothing of its own, because the <2s guard compares
    // 0 against 0.
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
  }, [video?.id, videoRef, progress]);

  return { progress, syncState };
}
