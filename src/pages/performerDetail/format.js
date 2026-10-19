/**
 * Pure formatters for the performer detail hero.
 *
 * Extracted so they can be unit-tested without a DOM, and so the page stays a
 * composition of state and markup.
 */

// Compute an age string from an ISO birthdate
export function ageFromBirthdate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
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
