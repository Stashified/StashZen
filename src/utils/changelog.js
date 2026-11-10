/**
 * changelog.js: the public build's release notes viewer.
 *
 * The file is fetched on demand from the public repo, never at boot, and only
 * when `__CHANGELOG_URL__` is set (the public workflow does that). Validation
 * is shared with scripts/publish-changelog.mjs, so a file CI accepts is one the
 * app can render.
 *
 * The app is deliberately lenient while the publisher is strict: a bad entry
 * is dropped rather than blanking the whole screen, but a wrong schema version
 * fails closed because its shape is unknown.
 */

import { fetchWithTimeout, StashError } from './stashClient.js';
import { compareVersions, isNewerVersion, parseVersionTag } from './updateCheck.js';

export const CHANGELOG_TIMEOUT_MS = 8000;
export const CHANGELOG_CACHE_TTL_MS = 10 * 60 * 1000;
export const CHANGELOG_MAX_BYTES = 256 * 1024;
export const CHANGELOG_MAX_RELEASES = 50;
export const CHANGELOG_MAX_SECTIONS = 24;
export const CHANGELOG_MAX_ITEMS = 12;
export const CHANGELOG_MAX_ITEM_CHARS = 500;
export const CHANGELOG_MAX_TITLE_CHARS = 80;
export const CHANGELOG_MAX_VIEW_RELEASES = 20;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Anything below U+0020 (newline and tab included) plus DEL. Items are
// one-line plain text; a stray control byte is a publisher mistake.
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

export function changelogArmed() {
  // `typeof` keeps a build config that forgets the define from throwing.
  return typeof __CHANGELOG_URL__ !== 'undefined' && !!__CHANGELOG_URL__;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isIsoDate(value) {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Round-trip through UTC: a range check alone accepts 2026-02-31.
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year
    && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day;
}

// 0.44 and 0.44.0 are the same version; pad so dedupe uses that, not strings.
function versionKey(version) {
  const parts = parseVersionTag(version);
  return parts ? `${parts.join('.')}${'.0'.repeat(4 - parts.length)}` : '';
}

/** Newest first; unreadable versions keep their relative order. */
export function sortReleasesNewestFirst(releases) {
  return releases.slice().sort((a, b) => compareVersions(b.version, a.version) ?? 0);
}

function normalizeSections(raw, strict, errors, where) {
  if (!Array.isArray(raw)) {
    if (strict) errors.push(`${where}.sections must be an array.`);
    return [];
  }
  if (raw.length > CHANGELOG_MAX_SECTIONS && strict) {
    errors.push(`${where}.sections has more than ${CHANGELOG_MAX_SECTIONS} entries.`);
  }
  const sections = [];
  raw.slice(0, CHANGELOG_MAX_SECTIONS).forEach((section, i) => {
    const at = `${where}.sections[${i}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      if (strict) errors.push(`${at} must be an object.`);
      return;
    }
    const title = normalizeText(section.title);
    if (!title || CONTROL_RE.test(title) || title.length > CHANGELOG_MAX_TITLE_CHARS) {
      if (strict) errors.push(`${at}.title must be 1-${CHANGELOG_MAX_TITLE_CHARS} plain characters.`);
      return;
    }
    if (!Array.isArray(section.items) || section.items.length === 0) {
      if (strict) errors.push(`${at}.items must be a non-empty array.`);
      return;
    }
    if (section.items.length > CHANGELOG_MAX_ITEMS && strict) {
      errors.push(`${at}.items has more than ${CHANGELOG_MAX_ITEMS} entries.`);
    }
    const items = [];
    section.items.slice(0, CHANGELOG_MAX_ITEMS).forEach((item, j) => {
      if (typeof item !== 'string') {
        if (strict) errors.push(`${at}.items[${j}] must be a string.`);
        return;
      }
      const text = normalizeText(item);
      if (!text || CONTROL_RE.test(text) || text.length > CHANGELOG_MAX_ITEM_CHARS) {
        if (strict) {
          errors.push(`${at}.items[${j}] must be 1-${CHANGELOG_MAX_ITEM_CHARS} plain characters.`);
        }
        return;
      }
      items.push(text);
    });
    if (items.length) sections.push({ title, items });
    else if (strict) errors.push(`${at}.items has no usable entries.`);
  });
  return sections;
}

/**
 * Strict check for the publisher and CI. Returns the normalised, sorted list.
 *
 * @returns {{ ok: boolean, errors: string[], releases?: Array }}
 */
export function validateChangelogPayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['The root must be an object.'] };
  }
  if (body.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1.');
  }
  if (!Array.isArray(body.releases)) {
    return { ok: false, errors: [...errors, 'releases must be an array.'] };
  }
  if (body.releases.length === 0) errors.push('releases must not be empty.');
  if (body.releases.length > CHANGELOG_MAX_RELEASES) {
    errors.push(`releases must have at most ${CHANGELOG_MAX_RELEASES} entries.`);
  }

  const seen = new Set();
  const releases = [];
  body.releases.slice(0, CHANGELOG_MAX_RELEASES).forEach((release, i) => {
    const where = `releases[${i}]`;
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
      errors.push(`${where} must be an object.`);
      return;
    }
    if (typeof release.version !== 'string') {
      errors.push(`${where}.version must be a string.`);
      return;
    }
    if (/^[vV]/.test(release.version.trim())) {
      errors.push(`${where}.version must not start with "v".`);
      return;
    }
    const parts = parseVersionTag(release.version);
    if (!parts) {
      errors.push(`${where}.version must be a dotted numeric version.`);
      return;
    }
    const version = parts.join('.');
    const key = versionKey(version);
    if (seen.has(key)) errors.push(`${where}.version ${version} is duplicated.`);
    seen.add(key);

    if (typeof release.date !== 'string' || !isIsoDate(release.date)) {
      errors.push(`${where}.date must be a real YYYY-MM-DD date.`);
    }
    const sections = normalizeSections(release.sections, true, errors, where);
    if (sections.length === 0) errors.push(`${where}.sections has no usable entries.`);
    releases.push({ version, date: release.date, sections });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], releases: sortReleasesNewestFirst(releases) };
}

/**
 * Lenient parse for the app. Drops entries it cannot render and returns an
 * empty list for a wrong schema version.
 */
export function parseChangelogPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  if (body.schemaVersion !== 1) return [];
  if (!Array.isArray(body.releases)) return [];

  const seen = new Set();
  const releases = [];
  for (const release of body.releases.slice(0, CHANGELOG_MAX_RELEASES)) {
    if (!release || typeof release !== 'object' || Array.isArray(release)) continue;
    const parts = typeof release.version === 'string' ? parseVersionTag(release.version) : null;
    if (!parts) continue;
    const version = parts.join('.');
    const key = versionKey(version);
    if (seen.has(key)) continue;
    seen.add(key);

    const sections = normalizeSections(release.sections, false, [], `releases[${version}]`);
    if (sections.length === 0) continue;
    const date = typeof release.date === 'string' && isIsoDate(release.date) ? release.date : '';
    releases.push({ version, date, sections });
  }
  return sortReleasesNewestFirst(releases);
}

/**
 * Which entries the viewer shows, newest first.
 *
 * Newer than the installed build; otherwise the installed build's own notes.
 * `none` when the file has never mentioned the installed version.
 */
export function selectChangelogReleases(releases, installedVersion) {
  const sorted = sortReleasesNewestFirst(releases);
  if (sorted.length === 0) return { mode: 'none', releases: [] };

  if (!parseVersionTag(installedVersion)) {
    // An unreadable build version should not blank the screen; show the newest.
    return { mode: 'current', releases: sorted.slice(0, 1) };
  }

  const newer = sorted
    .filter(entry => isNewerVersion(entry.version, installedVersion))
    .slice(0, CHANGELOG_MAX_VIEW_RELEASES);
  if (newer.length) return { mode: 'newer', releases: newer };

  const current = sorted.find(entry => compareVersions(entry.version, installedVersion) === 0);
  return current
    ? { mode: 'current', releases: [current] }
    : { mode: 'none', releases: [] };
}

/**
 * Fetch and parse the changelog. `fetchImpl` is injectable for the tests.
 *
 * No credentials, no body, no device information: a public file on a public
 * host, read only when the user opens the viewer.
 */
export async function fetchChangelog({
  url,
  timeoutMs = CHANGELOG_TIMEOUT_MS,
  fetchImpl = fetchWithTimeout,
}) {
  if (!url) return { ok: false, reason: 'unconfigured' };

  try {
    const text = await fetchImpl(
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs,
      async (res) => {
        if (!res.ok) {
          throw new StashError(`GitHub returned HTTP ${res.status}.`, 'http', res.status);
        }
        const declared = Number(res.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > CHANGELOG_MAX_BYTES) {
          throw new StashError('The changelog is too large.', 'size');
        }
        const body = await res.text();
        if (body.length > CHANGELOG_MAX_BYTES) {
          throw new StashError('The changelog is too large.', 'size');
        }
        return body;
      },
    );

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StashError('The changelog was unreadable.', 'parse');
    }
    const releases = parseChangelogPayload(parsed);
    if (releases.length === 0) {
      throw new StashError('The changelog was unreadable.', 'parse');
    }
    return { ok: true, releases };
  } catch (e) {
    const reason = e?.code === 'timeout' ? 'timeout'
      : e?.code === 'http' ? 'http'
        : e?.code === 'parse' ? 'parse'
          : e?.code === 'size' ? 'size' : 'network';
    return { ok: false, reason, status: e?.status };
  }
}

export function changelogFailureText(reason) {
  switch (reason) {
    case 'timeout': return 'The changelog took too long to load.';
    case 'http': return 'GitHub returned an error.';
    case 'parse': return 'The changelog was unreadable.';
    case 'size': return 'The changelog is too large to display.';
    case 'unconfigured': return '';
    default: return 'No network connection.';
  }
}
