import { useEffect, useRef } from 'react';
import {
  updateSceneRating,
  setSceneOrganized,
  addSceneO,
  resetSceneO,
  resetSceneProgress,
  markScenePlayed,
} from '../../utils/sceneService.js';

/**
 * The page's six writes.
 *
 * Each captures the prior value, paints the new one, writes, then either adopts
 * the server's answer or reverts. The server's answer wins because for the like
 * counter it is an atomic increment and can differ from our guess.
 *
 * Kept separate rather than folded into one helper: they look alike but differ
 * in what they adopt, which token guards them, and what they say.
 */
export function useSceneEdits({ detail, setDetail, flash, onActivityChange, canEdit }) {
  // Guards writes that can be in flight together. Responses are adopted in
  // arrival order unless a token says which press owns the screen: two quick
  // presses at a slow server can settle out of order, letting the first press's
  // count overwrite the second's, or a stale failure roll back a later success.
  // The counter is a tally, so the last press is what the user sees. One token
  // for the o-count (increment and clear write the same value); play count has
  // its own.
  const oAttemptRef = useRef(0);
  const playedAttemptRef = useRef(0);

  // Rating has its own token and confirmed value. The revert baseline must be
  // what the server last acknowledged, not `detail.rating100`, which holds the
  // previous press's optimistic value and would settle on a number Stash never
  // stored.
  const ratingAttemptRef = useRef(0);
  const ratingConfirmedRef = useRef(0);
  // Serialised so requests cannot reach the server out of order and leave the
  // stored value one press behind the screen.
  const ratingQueueRef = useRef(Promise.resolve());

  // The card's rating is a rounded display value; `canEdit` turns true exactly
  // when the detail query has replaced it with the authoritative one.
  useEffect(() => {
    if (canEdit) ratingConfirmedRef.current = detail?.rating100 ?? 0;
    // `detail` is read only at that transition; adding it to the deps would
    // reseed the confirmed value on every optimistic paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

  const setRating = (stars) => {
    const next = stars * 10;
    if (detail.rating100 === next) return;
    const sceneId = detail.id;
    const attempt = ++ratingAttemptRef.current;
    setDetail(d => ({ ...d, rating100: next }));
    ratingQueueRef.current = ratingQueueRef.current.then(async () => {
      try {
        const server = await updateSceneRating(sceneId, next);
        ratingConfirmedRef.current = server;
        if (attempt === ratingAttemptRef.current) {
          setDetail(d => ({ ...d, rating100: server }));
        }
      } catch (e) {
        // A stale failure belongs to a press the user has already replaced.
        if (attempt !== ratingAttemptRef.current) return;
        setDetail(d => ({ ...d, rating100: ratingConfirmedRef.current }));
        flash(`Rating not saved — ${e.message}`);
      }
    });
  };

  const toggleOrganized = async () => {
    const prev = !!detail.organized;
    const next = !prev;
    setDetail(d => ({ ...d, organized: next }));
    try {
      const server = await setSceneOrganized(detail.id, next);
      setDetail(d => ({ ...d, organized: server }));
      flash(server ? 'Marked as organised' : 'Organised mark removed');
    } catch (e) {
      setDetail(d => ({ ...d, organized: prev }));
      flash(`Not saved — ${e.message}`);
    }
  };

  /**
   * One more, every time.
   *
   * Not a toggle: Stash's counter is a tally, so pressing it three times must
   * leave three. Only the count decides what the button looks like.
   *
   * The optimistic value is a guess; Stash answers with the numbers it actually
   * holds (its own UI may have written in between), so the response wins.
   */
  const incrementLike = async () => {
    const attempt = ++oAttemptRef.current;
    const prev = detail.oCounter || 0;
    setDetail(d => ({ ...d, oCounter: prev + 1 }));
    try {
      const server = await addSceneO(detail.id);
      if (attempt !== oAttemptRef.current) return;
      if (typeof server === 'number') setDetail(d => ({ ...d, oCounter: server }));
    } catch (e) {
      if (attempt !== oAttemptRef.current) return;
      setDetail(d => ({ ...d, oCounter: prev }));
      flash(`o-count not saved — ${e.message}`);
    }
  };

  /**
   * Hold OK to clear it.
   *
   * Not confirmed and not on a press: undoing a tally one press at a time is
   * the tedium the hold exists to skip, and the gesture is hard to perform by
   * accident. It reports afterwards — a destructive action that says nothing
   * is indistinguishable from one that failed.
   */
  const clearLike = async () => {
    const prev = detail.oCounter || 0;
    if (prev === 0) { flash('o-count is already 0'); return; }
    // The same token as the increments: a press that was in flight when the
    // hold fired must not bring its count back after the reset.
    const attempt = ++oAttemptRef.current;
    setDetail(d => ({ ...d, oCounter: 0 }));
    try {
      const server = await resetSceneO(detail.id);
      if (attempt !== oAttemptRef.current) return;
      setDetail(d => ({ ...d, oCounter: typeof server === 'number' ? server : 0 }));
      flash(`o-count cleared (was ${prev})`);
    } catch (e) {
      if (attempt !== oAttemptRef.current) return;
      setDetail(d => ({ ...d, oCounter: prev }));
      flash(`o-count not cleared — ${e.message}`);
    }
  };

  /**
   * Drop the resume point, which is what removes the scene from Continue
   * Watching. Watch time is left alone: the two reset independently, and "clear
   * progress" is about where to resume from, not erasing that it was watched.
   *
   * App is told on success because the shelf underneath is still mounted and
   * holds the card this page came from; it would not refetch until the tab
   * remounted, so App prunes it in place instead.
   */
  const clearProgress = async () => {
    const prev = detail.resumeTime || 0;
    if (prev <= 0) { flash('No progress to clear'); return; }
    setDetail(d => ({ ...d, resumeTime: 0 }));
    try {
      const ok = await resetSceneProgress(detail.id);
      if (!ok) throw new Error('the server did not apply it');
      onActivityChange?.(detail.id, { resumeTime: 0 });
      flash('Progress cleared');
    } catch (e) {
      setDetail(d => ({ ...d, resumeTime: prev }));
      flash(`Progress not cleared — ${e.message}`);
    }
  };

  /**
   * Count one play now, without playing anything.
   *
   * A play is a row in Stash's view history, so this appends one through
   * `sceneAddPlay` rather than writing a count (the deprecated
   * `sceneIncrementPlayCount` is not on this schema). The optimistic count is a
   * guess; the server's `count` is the resulting total, possibly including
   * plays other clients recorded, so it replaces the guess.
   */
  const markPlayed = async () => {
    const attempt = ++playedAttemptRef.current;
    const prev = detail.playCount || 0;
    const prevLast = detail.lastPlayedAt || null;
    setDetail(d => ({
      ...d,
      playCount: prev + 1,
      lastPlayedAt: new Date().toISOString(),
    }));
    try {
      const res = await markScenePlayed(detail.id);
      if (attempt !== playedAttemptRef.current) return;
      if (!res.ok) throw res.error || new Error('the write failed');
      const count = typeof res.count === 'number' ? res.count : prev + 1;
      setDetail(d => ({ ...d, playCount: count }));
      flash(`Marked played (${count} ${count === 1 ? 'play' : 'plays'})`);
    } catch (e) {
      if (attempt !== playedAttemptRef.current) return;
      setDetail(d => ({ ...d, playCount: prev, lastPlayedAt: prevLast }));
      flash(`Not marked played — ${e.message}`);
    }
  };

  return { setRating, toggleOrganized, incrementLike, clearLike, clearProgress, markPlayed };
}
