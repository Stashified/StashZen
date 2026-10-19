#!/usr/bin/env node
/**
 * verify-filters.mjs — replay every saved filter against the live server.
 *
 *   node scripts/verify-filters.mjs            # report
 *   node scripts/verify-filters.mjs --verbose  # + the translated JSON per filter
 *
 * For each saved filter of each mode it sends the same query twice: once with
 * the stored `object_filter` forwarded verbatim (what the app did before
 * filterTranslate.js existed) and once translated. It reports the HTTP status
 * and row count of both, so the fix is measured rather than asserted.
 *
 * For SCENES it then goes one step further and calls the app's *real*
 * `fetchVideos` with the raw stored filter — the actual query text, the actual
 * wiring in loadVideos, the actual normaliser. Its count must match the
 * hand-translated one; a mismatch means the wiring, not the translator, is
 * wrong. (videoService imports cleanly under Node: settings.js catches the
 * missing `localStorage`, and `import.meta.env` is simply undefined here.)
 *
 * Dev-only: lives in scripts/, is never imported by src/, and so never reaches
 * the .wgt bundle.
 *
 * Only `count` is selected and only field *presence* is asserted — never a
 * title, path or any other scene metadata is printed. The translated JSON
 * printed by --verbose does contain the filter's own criteria (a folder path,
 * a tag id), which is why it is opt-in.
 *
 * Exits non-zero if any translated filter fails, so it can gate a release.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { translateFilter } from '../src/utils/filterTranslate.js';
import { setSettings } from '../src/utils/settings.js';
import { fetchVideos } from '../src/utils/videoService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

// ── credentials ───────────────────────────────────────────
function loadEnv() {
  const env = { ...process.env };
  if (env.VITE_STASH_URL && env.VITE_STASH_API_KEY) return env;
  try {
    for (const line of readFileSync(resolve(HERE, '../.env.production'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  } catch { /* no .env.production — explicit env is the only source */ }
  return env;
}

const env = loadEnv();
if (!env.VITE_STASH_URL) {
  console.error('No VITE_STASH_URL. Set it in the environment or in .env.production.');
  process.exit(1);
}
const ENDPOINT = env.VITE_STASH_URL.replace(/\/+$/, '') + '/graphql';

// Point the app's own settings store at the same server, so the end-to-end
// check below goes through the real service code rather than a copy of it.
// (persistToStorage's localStorage write is caught internally when absent.)
setSettings({ stashUrl: env.VITE_STASH_URL, stashKey: env.VITE_STASH_API_KEY || '' });

async function post(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.VITE_STASH_API_KEY ? { ApiKey: env.VITE_STASH_API_KEY } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* HTML or empty body */ }
  return { status: res.status, json };
}

// Each mode: the saved-filter FilterMode, the query that consumes it, the
// argument name, and the filter type filterTranslate dispatches on.
const MODES = [
  {
    mode: 'SCENES',
    filterType: 'SceneFilterType',
    arg: 'scene_filter',
    query: `query($f: FindFilterType, $scene_filter: SceneFilterType) {
      findScenes(filter: $f, scene_filter: $scene_filter) { count }
    }`,
    count: d => d?.findScenes?.count,
  },
  {
    mode: 'SCENE_MARKERS',
    filterType: 'SceneMarkerFilterType',
    arg: 'scene_marker_filter',
    query: `query($f: FindFilterType, $scene_marker_filter: SceneMarkerFilterType) {
      findSceneMarkers(filter: $f, scene_marker_filter: $scene_marker_filter) { count }
    }`,
    count: d => d?.findSceneMarkers?.count,
  },
  {
    mode: 'PERFORMERS',
    filterType: 'PerformerFilterType',
    arg: 'performer_filter',
    query: `query($f: FindFilterType, $performer_filter: PerformerFilterType) {
      findPerformers(filter: $f, performer_filter: $performer_filter) { count }
    }`,
    count: d => d?.findPerformers?.count,
  },
];

/** Run one filter and report { status, count, error }. */
async function probe(spec, filter) {
  const { status, json } = await post(spec.query, { f: { per_page: 1 }, [spec.arg]: filter });
  if (status !== 200) {
    return { status, count: null, error: json?.errors?.[0]?.message || `HTTP ${status}` };
  }
  if (json?.errors) {
    return { status, count: null, error: json.errors[0]?.message || 'GraphQL error' };
  }
  return { status, count: spec.count(json?.data), error: null };
}

/**
 * Drive the app's real fetch path — loadVideos' query, its translateFilter
 * call, its normaliser — for one *raw* stored filter. Only field presence is
 * asserted; no scene data is captured or printed.
 */
async function probeApp(rawFilter) {
  try {
    const { videos, total } = await fetchVideos({ filter: rawFilter, page: 1, limit: 1 });
    const card = videos[0];
    return {
      ok: true,
      total,
      card: !!card && !!card.id && typeof card.title === 'string' && 'thumbnail' in card,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Order-insensitive JSON. GraphQL input objects don't care about key order, and
 * the translator's own emission order legitimately differs between a first and a
 * second pass (the fixed-point step appends `depth`/`distance` after `modifier`).
 * Comparing raw JSON.stringify output would report that as a change.
 */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',') + '}';
  }
  return JSON.stringify(v);
}

// ── run ───────────────────────────────────────────────────
let failures = 0;
let checked = 0;
let rescued = 0;
let appChecks = 0;
let notIdempotent = 0;

for (const spec of MODES) {
  const { status, json } = await post(
    `query($m: FilterMode) {
      findSavedFilters(mode: $m) {
        id
        name
        find_filter { q sort direction }
        object_filter
      }
    }`,
    { m: spec.mode },
  );

  if (status !== 200 || json?.errors) {
    console.error(`${spec.mode}: cannot list saved filters (${json?.errors?.[0]?.message || `HTTP ${status}`})`);
    failures++;
    continue;
  }

  const saved = json.data.findSavedFilters || [];
  console.log(`\n══ ${spec.mode} — ${saved.length} saved filter${saved.length === 1 ? '' : 's'}`);
  if (!saved.length) continue;

  for (const f of saved) {
    const stored = typeof f.object_filter === 'string'
      ? (() => { try { return JSON.parse(f.object_filter); } catch { return null; } })()
      : f.object_filter;

    if (stored == null || typeof stored !== 'object') {
      // An empty object_filter means "no criteria" — the saved filter does its
      // work purely through find_filter.q, which the app already honours.
      console.log(`  ·  ${f.name} — no object_filter (search/sort only, already working)`);
      continue;
    }

    checked++;
    const before = await probe(spec, stored);
    const translated = translateFilter(stored, spec.filterType);
    const after = await probe(spec, translated);

    // Idempotency, asserted on real data rather than in a fixture: the services
    // translate unconditionally, and PerformerDetailPage already hands them a
    // GraphQL-shaped filter. A second pass must be a no-op.
    if (canonical(translateFilter(translated, spec.filterType)) !== canonical(translated)) {
      notIdempotent++;
      console.log(`  !  ${f.name} — translating twice changes the result`);
    }

    const ok = after.status === 200 && !after.error;
    if (!ok) failures++;
    if (ok && (before.error || before.status !== 200)) rescued++;

    // End-to-end through the app's own code, for the mode that has real filters.
    let appTxt = '';
    if (spec.mode === 'SCENES') {
      appChecks++;
      const app = await probeApp(stored);
      if (!app.ok) {
        failures++;
        appTxt = `   app ✗ ${app.error}`;
      } else if (app.total !== after.count) {
        failures++;
        appTxt = `   app ${app.total} ✗ MISMATCH (expected ${after.count})`;
      } else {
        appTxt = `   app ${app.total} ✓${app.card ? '' : ' (card has no id/title)'}`;
      }
    }

    const mark = ok ? (before.error || before.status !== 200 ? '✓✓' : '✓ ') : '✗ ';
    const beforeTxt = before.error ? `before: ${before.error}` : `before: ${before.count}`;
    const afterTxt = after.error ? `after: ${after.error}` : `after: ${after.count}`;
    console.log(`  ${mark} ${f.name.padEnd(24)} ${beforeTxt.padEnd(44)} ${afterTxt}${appTxt}`);

    if (VERBOSE) {
      console.log(`        translated = ${JSON.stringify(translated)}`);
    }
  }
}

console.log(`\n${'─'.repeat(72)}`);
if (!checked) {
  console.log('No saved filters with criteria were found — nothing to verify.');
} else {
  console.log(`${checked} saved filters with criteria · ${checked - failures}/${checked} pass · ${rescued} rescued by translation`);
  if (appChecks) console.log(`${appChecks} end-to-end checks through the app's own fetchVideos`);
  if (notIdempotent) console.log(`${notIdempotent} filters are not idempotent under a second translation`);
}
if (failures) {
  console.log(`${failures} still failing — see above.`);
  process.exit(1);
}
