/**
 * usePlayerMedia: the <video> element's wiring. The four effects here consume
 * the resume decision, the scene id and the resolver's answer, and only the
 * render consumes them, hence their last place in the hook order.
 *
 * Two invariants:
 *   - `onTimeUpd` drops ticks while `sourceFreshRef` is set; crediting runs
 *     only after that guard. It leaves the displayed clock alone while a skim
 *     gesture's seek is still unsent (`skimPendingRef`): the element is then
 *     playing on at the old position, which is not where the bar should go.
 *   - the wiring effect's dependency list is load-bearing: `video?.id` is the
 *     queue's change signal (the element survives an advance), and
 *     `effectiveStart` is there only to keep `onLoadedMd`'s closure fresh:
 *     widening the list would tear the listeners down mid-playback.
 */

import { useEffect, useLayoutEffect, useState } from 'react';
import { playbackFailureMessage } from './playerMessages.js';

export function usePlayerMedia({
  video,
  mediaRef,
  progress,
  showControls,
  effectiveStart,
  askingToResume,
  startSeekedRef,
  pendingLiveResumeRef,
  fallbackSeekRef,
  sourceFreshRef,
  skimPendingRef,
  playbackSrc,
  sourceSceneId,
  sourceExhausted,
  reportSourceFailure,
  codecs,
  goNext,
  setCurrentTime,
  setElementDuration,
  setError,
}) {
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);

  // Wire up the media events.
  //
  // A **layout** effect, not for layout reasons: the AVPlay session opens from
  // a passive effect declared above and `open()` can fail synchronously,
  // emitting `error` at that instant. A passive listener would attach after the
  // event, so the resolver never learned and the user sat on the poster. Layout
  // effects all run before any passive one, whatever the declaration order. The
  // autoplay effect below stays passive, because playing must follow opening.
  useLayoutEffect(() => {
    const v = mediaRef.current;
    const sceneId = video?.id;
    if (!v) return;

    const onPlay      = () => {
      // Replaying a finished scene is a new sitting: its position is reportable
      // again, or the completion latch would keep writing 0.
      if (v.currentTime < (v.duration || 0) - 1) progress.reopen();
      setPlaying(true);
      setBuffering(false);
    };
    const onPause     = () => setPlaying(false);
    const onWaiting   = () => setBuffering(true);

    // Where the play count is written (the once-per-scene latch is the
    // reporter's). `playing`, not mount: a scene that 404s is not watched.
    // Stale = the outgoing scene's session, whose play is not this scene's.
    const onPlaying   = () => {
      if (sourceFreshRef.current) return;
      setBuffering(false);
      progress.countPlay(sceneId);
    };

    const onTimeUpd   = () => {
      const t = v.currentTime;
      // Until this source reports metadata there is no timeline belonging to
      // it: the element may be announcing a reset to 0, or still be playing the
      // *outgoing* scene, whose clock would become this scene's playhead and
      // fallback target. Ignore the tick; the reporter keeps the pre-switch
      // position. See `sourceFreshRef`.
      if (sourceFreshRef.current) return;
      // The credit rule lives in the reporter's `tick`; a seek in flight must
      // not be credited even though it is not a pause.
      progress.tick(t, v.paused || v.seeking);
      // A paused seek back from the end emits no `play`, so the completion
      // latch must be cleared here or the teardown saves 0.
      if (v.currentTime < (v.duration || 0) - 1) progress.reopen();
      // A held skim owns the timeline until its seek lands: the element is
      // still playing at the old position, and syncing to it here made the
      // bar yoyo between the gesture target and the frame on screen.
      if (skimPendingRef?.current) return;
      setCurrentTime(t);
    };
    const onLoadedMd  = () => {
      // This source is real now: its timeline can be taken at face value.
      sourceFreshRef.current = false;
      setElementDuration(v.duration || 0);
      // A fallback source is a reload, not a new scene: resume from the live
      // playhead. Only a scene's first load starts from the resume decision.
      const fallback = fallbackSeekRef.current;
      let target = fallback.sceneId === (video?.id ?? null) && fallback.time > 0
        ? fallback.time
        : effectiveStart;
      // A live resume value that arrived before this load could not be applied
      // then; this is its second chance.
      if (!(target > 0) && pendingLiveResumeRef.current > 0 && !askingToResume) {
        target = pendingLiveResumeRef.current;
      }
      if (target > 0 && !startSeekedRef.current) {
        // Latched only if the seek took: a seek that threw (the usual case
        // before metadata) must be retried on the next loadedmetadata.
        try {
          v.currentTime = target;
          startSeekedRef.current = true;
          pendingLiveResumeRef.current = 0;
        } catch (e) { /* retried on the next loadedmetadata */ }
      }
    };
    // `loadedmetadata` is not the last word on duration: an element that cannot
    // measure the stream yet reports `Infinity` and supplies the real number in
    // a later `durationchange`. Without this the UI keeps the fallback forever.
    const onDurationChange = () => setElementDuration(v.duration || 0);
    // A media element's `error` event is not proof that *playback* failed: it
    // also fires for failing subresources (the poster, in some engines), while
    // `v.error` is set only for a genuine MediaError, without this guard a
    // healthy, still-playing video gets "Failed to load video" over it.
    //
    // The resolver gets first refusal: a scene whose codec the TV cannot decode
    // has a transcoded URL waiting, and this event is one of the two ways that
    // is noticed (the other is the stall watchdog, for silent failures).
    const onError     = (e) => {
      if (e.target !== v || !v.error) return;
      if (reportSourceFailure()) return;
      setError(playbackFailureMessage(codecs));
    };
    const onEnded     = () => {
      // The outgoing session's end is not this scene's: acting on it would
      // save 0 for the new scene and skip it.
      if (sourceFreshRef.current) return;
      // Report the finished scene before stepping off it: the teardown save
      // would otherwise be the only one, after the queue swapped the src.
      // `complete()` makes it a zero position, so the scene leaves Continue
      // Watching rather than staying at a full bar.
      progress.complete();
      progress.save(video?.id);
      // Advance only if there is somewhere to go, the last scene of a
      // queue stops where it is, with the controls up.
      goNext().then((moved) => { if (!moved) setPlaying(false); });
    };

    v.addEventListener('play',     onPlay);
    v.addEventListener('pause',    onPause);
    v.addEventListener('waiting',  onWaiting);
    v.addEventListener('playing',  onPlaying);
    v.addEventListener('timeupdate',     onTimeUpd);
    v.addEventListener('loadedmetadata', onLoadedMd);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('error',    onError);
    v.addEventListener('ended',    onEnded);

    // Not started from here, see the autoplay effect below. `autoPlay` is gone
    // from the element for the same reason: a saved position must not start
    // playing under the prompt asking about it.
    showControls();

    return () => {
      v.removeEventListener('play',     onPlay);
      v.removeEventListener('pause',    onPause);
      v.removeEventListener('waiting',  onWaiting);
      v.removeEventListener('playing',  onPlaying);
      v.removeEventListener('timeupdate',     onTimeUpd);
      v.removeEventListener('loadedmetadata', onLoadedMd);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('error',    onError);
      v.removeEventListener('ended',    onEnded);
      // The hide timer is not cleared here: `showControls()` in the body below
      // clears the pending one, and the visibility hook clears it on unmount.
    };
  }, [
    showControls, effectiveStart, video?.id, goNext, progress, reportSourceFailure,
    codecs, askingToResume, mediaRef, startSeekedRef,
    pendingLiveResumeRef, fallbackSeekRef, sourceFreshRef, skimPendingRef,
    setCurrentTime,
    setElementDuration, setError,
  ]);

  /**
   * Start playback once there is nothing left to ask. Its own effect because
   * folding it into the wiring would rebuild every listener whenever the answer
   * changed. `playing` is deliberately not a dependency: that would restart a
   * scene the user had paused.
   */
  useEffect(() => {
    const v = mediaRef.current;
    if (!v || !video?.id) return;
    // The old session is still open until the new source resolves; playing it
    // would restart the previous scene in the gap.
    if (sourceSceneId !== video.id) return;
    if (askingToResume) return;
    v.play().catch(() => {});
    // `playbackSrc` is here for the fallback, not the first load: changing the
    // element's `src` runs the load algorithm, which stops playback, so a
    // re-sourced scene would sit paused with nothing but the big ▶ to explain.
  }, [video?.id, askingToResume, playbackSrc, sourceSceneId, mediaRef]);

  /**
   * Re-arm the start seek when the source changes under a scene.
   *
   * `startSeekedRef` is per scene, which stops metadata re-seeking on every
   * later load. But a source switch *is* another load and resets `currentTime`
   * to 0; without this, a resumed scene falling back to a transcode would
   * restart from the beginning.
   */
  // The element's duration belongs to the source that reported it, so it goes
  // with it: a new scene shows *its* API duration at once instead of the
  // previous one's until it reports its own (never, for an MP4 transcode).
  //
  // A **layout** effect: the read must happen in the commit that swaps the
  // source, before the element's load task runs, because `loadedmetadata` reads
  // `fallbackSeekRef` and `sourceFreshRef`. As a passive effect the fallback
  // resumed at 0.4 s instead of 12.9 s, the target had been read from the
  // outgoing engine's empty timeline. Layout effects all run before the load.
  useLayoutEffect(() => {
    const sceneId = video?.id ?? null;
    const prev = fallbackSeekRef.current;
    // Same scene, different source is a fallback: keep the on-screen playhead.
    // A different scene inherits nothing, its first source starts from the
    // resume decision (or a marker).
    fallbackSeekRef.current = prev.sceneId === sceneId
      ? { sceneId, time: progress.position() }
      : { sceneId, time: 0 };
    startSeekedRef.current = false;
    sourceFreshRef.current = true;
    setElementDuration(0);
  }, [
    playbackSrc, video?.id, progress, fallbackSeekRef, startSeekedRef,
    sourceFreshRef, setElementDuration,
  ]);

  /**
   * Every candidate failed, the second way playback gives up. Here the
   * resolver ran out without the element rejecting a source (a missing direct
   * URL, transcoding off), while the `error` handler above is the element
   * refusing one it did load. Both end in the same sentence, hence one wording
   * in one function: two copies would drift. `sourceExhausted` starts false per
   * scene, so a scene never asked about or already playing is left alone.
   */
  useEffect(() => {
    if (!sourceExhausted) return;
    setError(playbackFailureMessage(codecs));
  }, [sourceExhausted, codecs, setError]);

  return { playing, buffering };
}
