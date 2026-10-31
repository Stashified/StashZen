/**
 * How long AppLock spent hidden, from the two clocks it stamps.
 *
 * `performance.now()` is monotonic, but on Linux-backed platforms it can stop
 * while the system is suspended, so a night in TV standby measures as
 * instants. `Date.now()` counts the suspend but can be set, or jump, so it is
 * only trusted forwards. The larger elapsed wins; a backwards wall clock means
 * the absence is unknown, and the caller locks.
 */
export function absenceMs(
  hiddenAt,
  now = { mono: performance.now(), wall: Date.now() },
) {
  const mono = now.mono - hiddenAt.mono;
  const wall = now.wall - hiddenAt.wall;
  if (wall < 0) return Infinity;
  return Math.max(mono, wall);
}
