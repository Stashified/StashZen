/**
 * The duration label for a queue row: "1h 4m" or "12m".
 *
 * Two shapes arrive from the two listings: `duration` is already a string from
 * Stash's scene summary, `durationSeconds` is the raw number the harness and
 * some fetches carry. Nothing is shown when neither is present, rather than a
 * guessed zero.
 */
export function durationText(item) {
  if (item?.duration) return item.duration;
  const s = item?.durationSeconds;
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
