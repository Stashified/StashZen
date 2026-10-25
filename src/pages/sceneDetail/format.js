// Local rather than shared: `videoService` has its own `formatDuration` for the
// card's "1h 24m" label, and this one keeps seconds under an hour.
export function fmtDuration(seconds) {
  if (!seconds) return null;
  // Round the total before splitting it: rounding the remainder alone turns
  // 3599.6 s into "59m 60s" instead of rolling over to 1h 0m.
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtBytes(bytes) {
  if (!bytes) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function fmtResolution(w, h) {
  if (!w || !h) return null;
  return `${w}×${h}`;
}

export function fmtDate(iso) {
  if (!iso) return null;
  return String(iso).slice(0, 10);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
