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

let pending = 0;

export function beginRestore() { pending += 1; }
export function endRestore() { pending = Math.max(0, pending - 1); }
export function isRestorePending() { return pending > 0; }
