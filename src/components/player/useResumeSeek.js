/**
 * useResumeSeek — where a scene starts: the prompt, the policy, and the seek
 * that has to be retried until the element can take it.
 *
 * One decision from four sides: whether to ask (`askingToResume`), what the
 * answer does (`chooseResume`), where the first `loadedmetadata` seeks
 * (`effectiveStart`), and a live value arriving after playback began.
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
  // Prefer the freshly-fetched value; fall back to the prop while it is in
  // flight.
  const resumeTime = liveResumeTime != null ? liveResumeTime : (video?.resume_time || 0);
  const duration_s = video?.durationSeconds || 0;

  // A saved position counts only mid-scene: near the start barely anything was
  // watched, near the end the scene is effectively finished.
  const usableResume = useCallback((t) =>
    t > RESUME_SKIP_THRESHOLD_S && (!duration_s || t < duration_s - RESUME_END_THRESHOLD_S),
  [duration_s]);

  const isUsefulResume = usableResume(resumeTime);

  /**
   * Whether to ask before playing.
   *
   * Decided from the **prop**, not `resumeTime`: the grid already holds it, so
   * opening never waits on a request — a slow or unreachable server must not
   * delay playback. The live fetch still wins for the seek target. A marker's
   * timestamp is never asked about; the user just named a position.
   */
  const propResume = video?.resume_time || 0;
  const askingToResume =
    startSeconds === 0 &&
    resumeChoice == null &&
    usableResume(propResume);

  // Marker activation wins; otherwise the saved position applies only on an
  // explicit "resume".
  const effectiveStart = startSeconds > 0
    ? startSeconds
    : (resumeChoice === 'resume' && isUsefulResume ? resumeTime : 0);

  /**
   * Answer the resume prompt.
   *
   * The seek happens here rather than through `effectiveStart`, because
   * `loadedmetadata` already fired while the question was on screen.
   * `startSeekedRef` tells a late live value that a seek happened, so it does
   * not re-seek to the position the user just declined.
   */
  const chooseResume = useCallback((choice) => {
    setResumeChoice(choice);
    if (choice !== 'resume') return;
    const v = mediaRef.current;
    // The prompt was decided from the prop, so the live value can be one the
    // policy rejects (finished, barely started): check it on the answer too.
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
   * The cached prop can be stale (the scene finished or was cleared since the
   * grid was fetched), and "resume" would then seek to a rejected position.
   * Leaving the question for a value the app will refuse is worse than starting.
   */
  useEffect(() => {
    if (!askingToResume || liveResumeTime == null) return;
    if (usableResume(liveResumeTime)) return;
    setResumeChoice('start');
  }, [askingToResume, liveResumeTime, usableResume, setResumeChoice]);

  // If the live resume value arrives after metadata loaded at a different
  // (cached) value, seek again to the correct position.
  useEffect(() => {
    if (liveResumeTime == null) return;
    const v = mediaRef.current;
    if (!v) return;
    // Don't override an explicit marker activation
    if (startSeconds > 0) return;
    // Nor while the question is up, nor after "start from the beginning". This
    // applies a resume *without* asking: the case where the prop had nothing
    // usable and the server's fresher value turned out to.
    if (askingToResume || resumeChoice === 'start') return;
    // If the seek already happened with the right value, no-op
    if (startSeekedRef.current && Math.abs(v.currentTime - liveResumeTime) < 1) return;
    // The prompt's policy. Checking only the start threshold let a scene paused
    // in its last 30 s open at 0 and then jump to the end.
    if (!usableResume(liveResumeTime)) return;
    try {
      v.currentTime = liveResumeTime;
      startSeekedRef.current = true;
    } catch (e) {
      // No metadata yet: keep it for `onLoadedMd`. A throwing seek must not be
      // lost — the latch alone would hide the value from every other path.
      pendingLiveResumeRef.current = liveResumeTime;
    }
  }, [
    liveResumeTime, startSeconds, askingToResume, resumeChoice, usableResume,
    mediaRef, startSeekedRef, pendingLiveResumeRef,
  ]);

  return { resumeTime, isUsefulResume, askingToResume, effectiveStart, chooseResume };
}
