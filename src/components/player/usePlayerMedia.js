/**
 * usePlayerMedia — the <video> element's wiring.
 *
 * The listener effect, the "may we play yet?" effect, the source-change
 * re-arm and the every-candidate-failed effect all belong to the element, and
 * they share `playing`, `buffering` and the seek latches. They are last in the
 * player's hook order for that reason: they consume the resume decision, the
 * scene id and the resolver's answer, and nothing consumes them except the
 * render.
 *
 * Two invariants worth restating here because they live in this effect:
 *   - `onTimeUpd` drops ticks while `sourceFreshRef` is set; the credit rule
 *     only runs after that guard.
 *   - the wiring effect's dependency list is load-bearing. `video?.id` is the
 *     queue's own change signal (the element survives an advance), and
 *     `effectiveStart` is present only so `onLoadedMd`'s closure is not
 *     stale — widening it would tear the listeners down mid-playback.
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
  playbackSrc,
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
  // A **layout** effect, and not for layout reasons: the player opens the
  // AVPlay session from a passive effect declared above this hook, and
  // `open()` can fail synchronously (the engine's `open`/`setListener`/
  // `prepareAsync` throwing is exactly the engine-level case). That failure
  // emits `error` immediately, into whatever listeners exist at that instant.
  // As a passive effect this listener was attached afterwards, so the event
  // was dispatched to nobody: the resolver never learned the session had
  // failed and the user sat on the poster with no fallback. Layout effects all
  // run before any passive one, whichever order they were declared in, so the
  // listener is in place for the first thing the open can do. The autoplay
  // effect below stays passive, because playing must still follow opening.
  useLayoutEffect(() => {
    const v = mediaRef.current;
    const sceneId = video?.id;
    if (!v) return;

    const onPlay      = () => {
      // Replaying a finished scene is a new sitting: its position is reportable
      // again. Without this the completion latch would keep writing 0 for the
      // rest of the session.
      if (v.currentTime < (v.duration || 0) - 1) progress.reopen();
      setPlaying(true);
      setBuffering(false);
    };
    const onPause     = () => setPlaying(false);
    const onWaiting   = () => setBuffering(true);

    // Where the play count is written. The once-per-scene latch is the
    // reporter's; `playing` and not mount because a scene that 404s should not
    // count as watched.
    const onPlaying   = () => {
      setBuffering(false);
      progress.countPlay(sceneId);
    };

    const onTimeUpd   = () => {
      const t = v.currentTime;
      // Until the current source reports metadata there is no timeline that
      // belongs to it: the element may be announcing a reset to 0, or — after
      // a queue advance removed `src` — still be playing the *outgoing*
      // scene, whose clock would otherwise be taken as this scene's playhead
      // and used as the fallback seek target. Ignore the tick entirely; the
      // position to save is the reporter's, from before the switch. See
      // `sourceFreshRef`.
      if (sourceFreshRef.current) return;
      // The credit rule (playback vs seek) lives in the reporter's `tick`, and
      // a seek in flight must not be credited even though it is not a pause.
      progress.tick(t, v.paused || v.seeking);
      setCurrentTime(t);
    };
    const onLoadedMd  = () => {
      // This source is real now: its timeline may be taken at face value.
      sourceFreshRef.current = false;
      setElementDuration(v.duration || 0);
      // A fallback source is a reload, not a new scene: it must resume from the
      // playhead the user was at. Only the first load of a scene starts from
      // the resume decision.
      const fallback = fallbackSeekRef.current;
      let target = fallback.sceneId === (video?.id ?? null) && fallback.time > 0
        ? fallback.time
        : effectiveStart;
      // A live resume value that arrived before this load could not be
      // applied then; this is its second chance.
      if (!(target > 0) && pendingLiveResumeRef.current > 0 && !askingToResume) {
        target = pendingLiveResumeRef.current;
      }
      if (target > 0 && !startSeekedRef.current) {
        // Latched only if the seek took. Latching first meant a seek that
        // threw — the usual case before metadata — was never retried.
        try {
          v.currentTime = target;
          startSeekedRef.current = true;
          pendingLiveResumeRef.current = 0;
        } catch (e) { /* retried on the next loadedmetadata */ }
      }
    };
    // `loadedmetadata` is not always the last word on duration: an element
    // that cannot measure the stream yet reports `Infinity` there and supplies
    // the real number in a later `durationchange`. Without this listener the
    // UI would keep the fallback for the rest of the scene even after the
    // element had learned better.
    const onDurationChange = () => setElementDuration(v.duration || 0);
    // A media element's `error` event is not proof that *playback* failed: it
    // also fires for failing subresources (the poster, in some engines), while
    // `v.error` is set only for a genuine MediaError. Without this guard a
    // perfectly healthy, still-playing video gets a "Failed to load video"
    // overlay drawn on top of it.
    //
    // The source resolver gets first refusal, though. A scene whose codec the
    // TV cannot decode has a transcoded URL waiting as its second candidate,
    // and this event is one of the two ways that gets noticed — the other is
    // the stall watchdog, for the codecs that fail *silently*, which is the
    // case this was reported as. Reporting here instead would put "Failed to
    // load video" over a scene that is about to play.
    const onError     = (e) => {
      if (e.target !== v || !v.error) return;
      if (reportSourceFailure()) return;
      setError(playbackFailureMessage(codecs));
    };
    const onEnded     = () => {
      // Report the finished scene before stepping off it. The teardown save
      // would otherwise be the only one, and by then the queue has already
      // swapped the src out from under it. `complete()` makes that report a
      // zero position, so the scene leaves Continue Watching instead of
      // staying on it at a full bar.
      progress.complete();
      progress.save(video?.id);
      // Advance only if there is somewhere to go — the last scene of a
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

    // Not started from here — see the autoplay effect below. `autoPlay` is gone
    // from the element for the same reason: a scene with a saved position must
    // not start playing underneath the prompt that is asking about it.
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
      // The hide timer is not cleared here: the wiring body below re-arms it
      // with `showControls()`, which clears whatever was pending, and the
      // visibility hook clears it on unmount.
    };
  }, [
    showControls, effectiveStart, video?.id, goNext, progress, reportSourceFailure,
    codecs, askingToResume, mediaRef, startSeekedRef,
    pendingLiveResumeRef, fallbackSeekRef, sourceFreshRef, setCurrentTime,
    setElementDuration, setError,
  ]);

  /**
   * Start playback, once there is nothing left to ask.
   *
   * Its own effect rather than a line in the wiring above, because it answers a
   * different question — "may we play yet?" — and folding it in would tear down
   * and rebuild every listener each time the answer changed.
   *
   * `playing` is deliberately not a dependency: that would restart a scene the
   * user had paused on the next render that settled the state.
   */
  useEffect(() => {
    const v = mediaRef.current;
    if (!v || !video?.id) return;
    if (askingToResume) return;
    v.play().catch(() => {});
    // `playbackSrc` is here for the fallback, not for the first load: changing
    // the element's `src` runs the media load algorithm, which stops playback.
    // A scene that had to be re-sourced would otherwise sit loaded and paused
    // with nothing but the big ▶ to explain itself.
  }, [video?.id, askingToResume, playbackSrc, mediaRef]);

  /**
   * Re-arm the start seek when the source changes under a scene.
   *
   * `startSeekedRef` is per scene — that is what stops metadata re-seeking on
   * every subsequent load. But a source switch *is* another load, and it resets
   * `currentTime` to zero; without this, a resumed scene that fell back to a
   * transcode would restart from the beginning, which reads as the app having
   * forgotten where it was.
   */
  // The element's duration belongs to the source that reported it, so it goes
  // with it. Dropping it here means the new scene shows *its* duration from
  // the API immediately, instead of the previous scene's until this one
  // reports its own — which for an MP4 transcode is never.
  //
  // A **layout** effect for the same class of reason the wiring above is one.
  // The read has to happen in the commit that swaps the source, before the
  // element's load task runs: an engine hand-off mounts the `<video>` and sets
  // its `src`, and `loadedmetadata` reads `fallbackSeekRef` and
  // `sourceFreshRef`. As a passive effect this ran after the element had
  // already started, and the harness caught the consequence once in a sweep —
  // the browser fallback resumed at 0.4 s instead of 12.9 s, because the seek
  // target had still been read from the outgoing engine's empty timeline and
  // `loadedmetadata` had arrived before the latch was armed. Layout effects
  // all run before the load task, so the capture is never late.
  useLayoutEffect(() => {
    const sceneId = video?.id ?? null;
    const prev = fallbackSeekRef.current;
    // Same scene, different source: that is a fallback, and the playhead on
    // screen is where the user was. A different scene inherits nothing — its
    // first source starts from the resume decision (or a marker), not from the
    // outgoing scene's position.
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
   * Every candidate failed.
   *
   * This is the second of the two ways playback gives up, and they are worth
   * keeping separate because they carry different information: here the
   * resolver ran out of candidates without the element ever rejecting one —
   * a direct URL that is not there and a server with transcoding off — while
   * the `error` handler above is the element refusing a source it *did* load.
   * Both end in the same sentence, which is why the wording lives in one
   * function rather than in each of them; two copies would drift, and the
   * user would see whichever one happened to run last.
   *
   * A scene that was never asked about, or already playing, must not be given
   * an error by this: `sourceExhausted` starts false and is per scene.
   */
  useEffect(() => {
    if (!sourceExhausted) return;
    setError(playbackFailureMessage(codecs));
  }, [sourceExhausted, codecs, setError]);

  return { playing, buffering };
}
