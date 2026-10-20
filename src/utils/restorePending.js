/**
 * restorePending — "focus is on its way".
 *
 * A listing that remounts after Back focuses its first card after 50 ms so
 * the D-pad always has somewhere to go. When Back is also restoring a
 * specific card, that first card is the *wrong* one: it flashes into focus
 * and the cursor jumps off it again when the restore lands. This flag lets
 * the auto-focus step aside for the duration.
 *
 * Its own module rather than a flag in focus.js because both focus.js (which
 * raises it) and useFocusable.js (which reads it) would otherwise import each
 * other.
 */

let pending = 0;

export function beginRestore() { pending += 1; }
export function endRestore() { pending = Math.max(0, pending - 1); }
export function isRestorePending() { return pending > 0; }
