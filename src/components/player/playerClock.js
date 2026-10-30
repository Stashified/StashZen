/**
 * The player's clock, a tiny external store.
 *
 * `timeupdate` arrives about four times a second. As player state it re-rendered
 * the whole tree at that rate, though only the seek bar and the time row print
 * the value. Those two subscribe here instead, and the near-end flag is kept
 * apart so entering the last 30 seconds re-renders the player once, not on
 * every tick.
 */
export function createPlayerClock(initial = 0) {
  let time = initial;
  let nearEnd = false;
  let secondsLeft = 0;
  const timeSubs = new Set();
  const nearSubs = new Set();
  const leftSubs = new Set();

  return {
    getTime: () => time,
    subscribeTime(fn) {
      timeSubs.add(fn);
      return () => timeSubs.delete(fn);
    },
    setTime(next) {
      if (next === time) return;
      time = next;
      timeSubs.forEach(fn => fn());
    },
    getNearEnd: () => nearEnd,
    subscribeNearEnd(fn) {
      nearSubs.add(fn);
      return () => nearSubs.delete(fn);
    },
    setNearEnd(next) {
      if (next === nearEnd) return;
      nearEnd = next;
      nearSubs.forEach(fn => fn());
    },
    // Whole seconds only: the card's countdown does not need the tick rate.
    getSecondsLeft: () => secondsLeft,
    subscribeSecondsLeft(fn) {
      leftSubs.add(fn);
      return () => leftSubs.delete(fn);
    },
    setSecondsLeft(next) {
      if (next === secondsLeft) return;
      secondsLeft = next;
      leftSubs.forEach(fn => fn());
    },
  };
}
