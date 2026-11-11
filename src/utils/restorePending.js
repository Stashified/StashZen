/**
 * restorePending, "focus is on its way".
 *
 * A remounted listing focuses its first card after 50 ms so the D-pad has
 * somewhere to go. When Back is restoring a specific card, that first card is
 * the *wrong* one: it flashes into focus and jumps off when the restore lands.
 * This flag lets auto-focus step aside.
 *
 * Its own module because focus.js (raises it) and useFocusable.js (reads it)
 * would otherwise import each other.
 */

/**
 * Both sides of the hold read the same flag: the remounted listing's first-card
 * autofocus waits, and arrows are swallowed while focus sits on <body> (see
 * isRestoreArrowHold). A normal restore lands in well under a second; the
 * window is generous for a slow one.
 *
 * It is bounded so that a restore which cannot land (a deleted card, an id from
 * another tab) still ends with a focus target and working arrows. The bound is
 * deliberately under focus.js's 8 s restore deadline: past it the first card
 * takes focus and the restore may still land later, which is a hop in a
 * pathological case rather than an inert remote for seconds.
 *
 * Each restore holds its own token, so a restore that outlives the bound cannot
 * release a newer one when its `endRestore` finally arrives.
 */

const HOLD_MAX_MS = 4000;

// token -> { at, swallowed }
const holds = new Map();
let nextToken = 0;

function prune(now) {
  for (const [token, hold] of holds) {
    if (now - hold.at >= HOLD_MAX_MS) holds.delete(token);
  }
}

/** Raise the hold; pass the token back to `endRestore` when the restore ends. */
export function beginRestore() {
  const now = Date.now();
  prune(now);
  const token = ++nextToken;
  holds.set(token, { at: now, swallowed: false });
  return token;
}

export function endRestore(token) { holds.delete(token); }

/** The newest unexpired token, or null. */
function newest(now) {
  prune(now);
  let best = null;
  for (const token of holds.keys()) {
    if (best === null || token > best) best = token;
  }
  return best;
}

export function isRestorePending() {
  return newest(Date.now()) !== null;
}

/**
 * Spend the restore's one free arrow press.
 *
 * Back followed by one quick press is the case the hold exists for, so that
 * press is swallowed. A second press is the user asking to move now, and its
 * verdict is false so the restore settles. Returns true while the press should
 * still be swallowed.
 */
export function claimArrowSwallow() {
  const token = newest(Date.now());
  if (token === null) return false;
  const hold = holds.get(token);
  if (hold.swallowed) return false;
  hold.swallowed = true;
  return true;
}
