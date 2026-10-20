/**
 * Shared display formatters.
 *
 * formatTime — seconds → "H:MM:SS" (or "M:SS" under an hour).
 *
 * Three components had their own near-identical copy of this arithmetic,
 * and they had drifted in exactly one place: the player floored at
 * "00:00" and padded the minutes, the two card badges floored at "0:00"
 * and didn't. The player's padding is the deliberate one — a padded
 * readout doesn't reflow when playback crosses the one-minute mark,
 * which is visible on a TV. So the difference is now an explicit flag
 * rather than two implementations that happened to disagree.
 */

/**
 * A file name without its extension: "DSC_0001.JPG" → "DSC_0001".
 *
 * For an image with no Stash title — common enough that the Images grid looked
 * bare — this is the file's own name, which is what the tile would otherwise
 * say if the title had been populated. Only the last extension is dropped, so
 * "holiday.2024.raw" → "holiday.2024"; a leading dot is not an extension
 * (".hidden" is a stem, not a file with no name).
 *
 * Returns null for anything that is not a non-empty string, so a caller can
 * keep its own fallback rather than print "null" or "undefined".
 */
export function filenameStem(basename) {
  if (typeof basename !== 'string') return null;
  const name = basename.trim();
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function formatTime(seconds, { padMinutes = false } = {}) {
  if (!isFinite(seconds) || seconds < 0) return padMinutes ? '00:00' : '0:00';

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');

  return h > 0 ? `${h}:${mm}:${ss}` : padMinutes ? `${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Group a count with commas. Done by hand rather than with `toLocaleString`,
 * whose grouping can vary with the engine's locale data — the harness and the
 * TV's Chromium 56 should produce the same string.
 */
export function formatCount(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '0';
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
}

/**
 * 1024-based sizes, one decimal where it means something. Stash reports byte
 * sums as integers; `0 B` covers both a missing value and an empty library.
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * A job's start time as a wall clock, "HH:MM" in the TV's own timezone.
 *
 * Deliberately not a date: a job in the queue started today, and the full date
 * is noise in a one-line footer. A date does appear for a job that started
 * before midnight — "Started 23:40" on a snapshot taken at 00:05 is still
 * true, and guessing at a date format would cost more than the ambiguity.
 * Returns null for anything the browser cannot parse, so a malformed value
 * hides the line rather than rendering "Invalid Date".
 */
export function formatJobStart(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Rounded hours. Rounding rather than flooring matters at the boundary: a
 * library of 1,250.5 h should read 1,251 h, not 1,250 h.
 */
export function formatHours(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '0 h';
  return `${formatCount(Math.round(s / 3600))} h`;
}
