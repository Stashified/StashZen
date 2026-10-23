/**
 * useResumeSeek — where a scene starts: the prompt, the policy, and the seek
 * that has to be retried until the element can take it.
 *
 * Kept together because they are one decision seen from four sides: whether
 * to ask (`askingToResume`), what to do with the answer (`chooseResume`), where
 * the first `loadedmetadata` should seek (`effectiveStart`), and what to do
 * with a live value that arrives after playback has begun. Splitting them
 * would leave each half re-deriving the policy from the other's state.
 */

import { useCallback, useEffect } from 'react';
import { RESUME_SKIP_THRESHOLD_S, RESUME_END_THRESHOLD_S } from './constants.js';

export function useResumeSeek({
  video,
  mediaRef,
  liveResumeTime,
  resumeChoice,
  setResumeChoice,
  startSeconds,
  startSeekedRef,
  pendingLiveResumeRef,
  setCurrentTime,
}) {
  // Prefer the freshly-fetched value over whatever the grid had cached. Falls
  // back to the prop value while the fetch is in flight.
  const resumeTime = liveResumeTime != null ? liveResumeTime : (video?.resume_time || 0);
  const duration_s = video?.durationSeconds || 0;

  // A saved position is only worth acting on when it is somewhere in the
  // middle: too near the start and the user barely watched, too near the end
  // and the scene is effectively finished.
  const usableResume = useCallback((t) =>
    t > RESUME_SKIP_THRESHOLD_S && (!duration_s || t < duration_s - RESUME_END_THRESHOLD_S),
  [duration_s]);

  const isUsefulResume = usableResume(resumeTime);

  /**
   * Whether to ask before playing.
   *
   * Decided from the **prop**, not from `resumeTime`. The prop is the value the
   * grid already holds, so opening a scene never waits on a request before it
   * can start; the live fetch still wins for the seek target further down. The
   * two agree in practice, because every save drops the page cache — but the
   * difference decides whether a slow or unreachable server delays playback,
   * and it must not. A marker's timestamp is never asked about: the user just
   * named a position, so there is nothing to check with them.
   */
  const propResume = video?.resume_time || 0;
  const askingToResume =
    startSeconds === 0 &&
    resumeChoice == null &&
    usableResume(propResume);

  // Marker activation wins; otherwise the saved position applies only once the
  // user has said so.
  const effectiveStart = startSeconds > 0
    ? startSeconds
    : (resumeChoice === 'resume' && isUsefulResume ? resumeTime : 0);

  /**
   * Answer the resume prompt.
   *
   * The seek is applied here rather than left to `effectiveStart`, because
   * `loadedmetadata` has already fired by the time the prompt is answered — the
   * element loaded its metadata while the question was on screen — so the
   * handler that seeks on that event will not run again. Setting
   * `startSeekedRef` is what tells the late-arriving live value that a seek has
   * happened, so it does not re-seek to the position the user just declined.
   */
  const chooseResume = useCallback((choice) => {
    setResumeChoice(choice);
    if (choice !== 'resume') return;
    const v = mediaRef.current;
    // The prompt was decided from the prop, so the live value it would seek to
    // can be one the policy rejects (finished, or barely started). Honour the
    // policy on the answer as well as on the question.
    if (!v || !usableResume(resumeTime)) return;
    try {
      v.currentTime = resumeTime;
      setCurrentTime(resumeTime);
      startSeekedRef.current = true;
    } catch (e) {
      // Not seekable yet — `onLoadedMd` will do it from `effectiveStart`.
    }
  }, [mediaRef, setResumeChoice, usableResume, resumeTime, setCurrentTime, startSeekedRef]);

  /**
   * Withdraw the resume question when the server's fresher answer says it
   * should not have been asked.
   *
   * The prompt is decided from the cached prop so it can appear without
   * waiting on a request (see `askingToResume`). That prop can be stale in
   * either direction: the scene may have been finished, or cleared, since the
   * grid was fetched. Answering "resume" then seeks to a position the policy
   * rejects — and leaving the question on screen for a value the app will
   * refuse to use is worse than simply starting, which is what the server has
   * told us the right answer is.
   */
  useEffect(() => {
    if (!askingToResume || liveResumeTime == null) return;
    if (usableResume(liveResumeTime)) return;
    setResumeChoice('start');
  }, [askingToResume, liveResumeTime, usableResume, setResumeChoice]);

  // If the live resume value arrives after metadata has already loaded
  // at a different (cached) value, seek again to the correct position.
  useEffect(() => {
    if (liveResumeTime == null) return;
    const v = mediaRef.current;
    if (!v) return;
    // Don't override an explicit marker activation
    if (startSeconds > 0) return;
    // Nor while the question is still on screen, nor when the answer was
    // "start from the beginning". This effect exists to apply a resume *without*
    // asking — which, now that there is a prompt, is only the case when the prop
    // had nothing usable and the server's fresher value turned out to.
    if (askingToResume || resumeChoice === 'start') return;
    // If the seek already happened with the right value, no-op
    if (startSeekedRef.current && Math.abs(v.currentTime - liveResumeTime) < 1) return;
    // The same policy the prompt uses. Checking only the start threshold let a
    // scene paused in its last 30 s open at 0 and then jump to the end.
    if (!usableResume(liveResumeTime)) return;
    try {
      v.currentTime = liveResumeTime;
      startSeekedRef.current = true;
    } catch (e) {
      // No metadata yet. Keep it for `onLoadedMd` — the seek that throws is
      // exactly the one that used to be lost, because the latch was set
      // regardless and nothing else knew the value.
      pendingLiveResumeRef.current = liveResumeTime;
    }
  }, [
    liveResumeTime, startSeconds, askingToResume, resumeChoice, usableResume,
    mediaRef, startSeekedRef, pendingLiveResumeRef,
  ]);

  return { resumeTime, isUsefulResume, askingToResume, effectiveStart, chooseResume };
}
