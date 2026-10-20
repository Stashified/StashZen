/**
 * Pure formatters for the performer detail hero.
 *
 * Extracted so they can be unit-tested without a DOM, and so the page stays a
 * composition of state and markup.
 */

/**
 * Calendar parts of a Stash date string, or null.
 *
 * Deliberately not `new Date(iso)`: a plain `YYYY-MM-DD` is parsed as UTC
 * midnight, and reading it back with the local getters shifts the day west of
 * Greenwich. That is the same defect videoService.yearOf avoids by matching
 * the string instead of constructing a Date.
 */
function dateParts(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Age in whole years, measured to the death date when there is one.
 *
 * The hero already prints a "Died …" fact, so measuring a deceased performer
 * to today would leave "Age 81" next to "Died 2009" and keep growing it. The
 * reference date is injected so the day-boundary rule can be tested without
 * moving the machine's clock or timezone.
 */
export function ageFromBirthdate(iso, deathDate = null, now = new Date()) {
  const birth = dateParts(iso);
  if (!birth) return null;
  const end = dateParts(deathDate);
  const ref = end || {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
  let age = ref.year - birth.year;
  if (ref.month < birth.month || (ref.month === birth.month && ref.day < birth.day)) {
    age--;
  }
  return age >= 0 ? age : null;
}

export function formatHeight(cm) {
  if (!cm) return null;
  // Round to whole inches first, then split. Rounding only the remainder
  // prints 5′12″ for, say, 182 cm; carrying the 12 is the same mistake a
  // careless clock makes at 59.6 minutes.
  const totalInches = Math.round(cm / 2.54);
  const ft = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${cm} cm · ${ft}′${inches}″`;
}

// GenderEnum is SCREAMING_SNAKE and is not meant to be read raw. Unknown
// values (a newer Stash adds one) fall back to words rather than disappearing.
export function formatGender(value) {
  if (!value) return null;
  const labels = {
    MALE: 'Male',
    FEMALE: 'Female',
    TRANSGENDER_MALE: 'Transgender male',
    TRANSGENDER_FEMALE: 'Transgender female',
    INTERSEX: 'Intersex',
    NON_BINARY: 'Non-binary',
  };
  return labels[value] || String(value).replace(/_/g, ' ').toLowerCase();
}

// Stash stores career bounds as strings, in practice a date ("1999-04-01").
export function yearOf(value) {
  const m = String(value).match(/^\d{4}/);
  return m ? m[0] : String(value);
}

// Prefer the two bounds; `career_length` is a free string ("12 years") and is
// only the fallback when neither bound is recorded.
export function formatCareer({ careerStart, careerEnd, careerLength } = {}) {
  if (careerStart && careerEnd) return `${yearOf(careerStart)}–${yearOf(careerEnd)}`;
  if (careerStart) return `${yearOf(careerStart)}–`;
  if (careerEnd) return `–${yearOf(careerEnd)}`;
  return careerLength || null;
}

function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * One chip per host, in the order Stash returned them. A performer can list
 * the same site more than once (`urls` is a plain list), and a chip per URL
 * would repeat the same label; the first URL for a host wins.
 *
 * Returns `{ links: [{ url, host }], omitted }`, where `omitted` counts the
 * distinct hosts past `max`. Invalid URLs fall back to the raw string as the
 * host, so a malformed entry is still readable rather than silently dropped.
 */
export function webLinks(urls, max = 3) {
  const seen = new Set();
  const distinct = [];
  for (const url of urls || []) {
    if (!url) continue;
    const host = hostOf(url) || String(url);
    if (seen.has(host)) continue;
    seen.add(host);
    distinct.push({ url, host });
  }
  return {
    links: distinct.slice(0, max),
    omitted: Math.max(0, distinct.length - max),
  };
}

/** Stash stores `death_date` as a plain date string; null and '' mean alive. */
export function formatDeathDate(value) {
  return value || null;
}

/**
 * The grid's `rating` is `(rating100 / 10).toFixed(1)`, so this round-trip is
 * exact. It seeds the hero on the first paint; the detail query's `rating100`
 * replaces it as soon as it lands, and every write uses that value.
 */
export function ratingFromCard(performer) {
  if (!performer?.rating) return 0;
  const n = Number(performer.rating);
  return Number.isFinite(n) ? Math.round(n * 10) : 0;
}
