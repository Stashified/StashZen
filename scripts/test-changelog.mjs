#!/usr/bin/env node
/**
 * Tests for the changelog parser, selection and publisher helpers.
 *
 * No network: `fetchChangelog` takes its transport as an argument, so every
 * failure branch is exercised with a fake Response.
 */

import {
  CHANGELOG_MAX_BYTES, CHANGELOG_MAX_VIEW_RELEASES,
  changelogFailureText, fetchChangelog, parseChangelogPayload,
  selectChangelogReleases, sortReleasesNewestFirst, validateChangelogPayload,
} from '../src/utils/changelog.js';
import { StashError } from '../src/utils/stashClient.js';
import {
  addRelease, parseDraft, renderReleaseBody,
} from './publish-changelog.mjs';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const RELEASE = (version, date, items) => ({
  version,
  date,
  sections: [{ title: 'Changes', items }],
});

const PAYLOAD = {
  schemaVersion: 1,
  releases: [
    RELEASE('0.43.1', '2026-11-08', ['First patch.']),
    RELEASE('0.44.0', '2026-11-20', ['Second release.']),
    RELEASE('0.42.0', '2026-10-01', ['Older release.']),
  ],
};

// ── Strict validation ────────────────────────────────────
{
  const res = validateChangelogPayload(PAYLOAD);
  check('valid payload passes', res.ok === true, res.errors.join(' | '));
  check('valid payload is sorted newest first',
    res.releases?.map(r => r.version).join(',') === '0.44.0,0.43.1,0.42.0',
    res.releases?.map(r => r.version).join(','));

  check('a wrong schema version fails',
    validateChangelogPayload({ ...PAYLOAD, schemaVersion: 2 }).ok === false);
  check('an empty release list fails',
    validateChangelogPayload({ schemaVersion: 1, releases: [] }).ok === false);
  check('a non-object root fails', validateChangelogPayload([]).ok === false);

  const duplicate = validateChangelogPayload({
    schemaVersion: 1,
    releases: [RELEASE('0.44.0', '2026-11-20', ['a']), RELEASE('0.44', '2026-11-20', ['b'])],
  });
  check('a duplicated version fails', duplicate.ok === false,
    duplicate.errors.join(' | '));

  check('a "v" prefix fails',
    validateChangelogPayload({
      schemaVersion: 1, releases: [RELEASE('v0.44.0', '2026-11-20', ['a'])],
    }).ok === false);
  check('a missing date fails',
    validateChangelogPayload({
      schemaVersion: 1, releases: [{ version: '0.44.0', sections: [{ title: 'x', items: ['a'] }] }],
    }).ok === false);
  check('an impossible date fails',
    validateChangelogPayload({
      schemaVersion: 1, releases: [RELEASE('0.44.0', '2026-13-40', ['a'])],
    }).ok === false);
  check('an empty item list fails',
    validateChangelogPayload({
      schemaVersion: 1,
      releases: [{ version: '0.44.0', date: '2026-11-20', sections: [{ title: 'x', items: [] }] }],
    }).ok === false);
}

// ── Lenient parse ────────────────────────────────────────
{
  const parsed = parseChangelogPayload(PAYLOAD);
  check('the app parses a valid payload newest first',
    parsed.map(r => r.version).join(',') === '0.44.0,0.43.1,0.42.0');
  check('a wrong schema version yields nothing',
    parseChangelogPayload({ ...PAYLOAD, schemaVersion: 2 }).length === 0);

  const messy = parseChangelogPayload({
    schemaVersion: 1,
    releases: [
      RELEASE('0.44.0', '2026-11-20', ['  keep   me  ', '', 42, 'another']),
      RELEASE('0.44.0', '2026-11-20', ['duplicate version']),
      { version: 'not-a-version', date: '2026-11-20', sections: [{ title: 'x', items: ['a'] }] },
      { version: '0.43.0', date: 'nope', sections: [{ title: 'x', items: ['kept'] }] },
    ],
  });
  check('the app drops duplicate versions',
    messy.filter(r => r.version === '0.44.0').length === 1,
    messy.map(r => r.version).join(','));
  check('the app drops unusable versions', !messy.some(r => r.version === 'not-a-version'));
  check('the app normalises item whitespace and drops non-strings',
    messy[0]?.sections[0].items.join('|') === 'keep me|another',
    messy[0]?.sections[0].items.join('|'));
  check('a bad date is kept as an empty string', messy[1]?.date === '');

  const noSections = parseChangelogPayload({
    schemaVersion: 1,
    releases: [{ version: '0.44.0', date: '2026-11-20', sections: [] }],
  });
  check('a release with no usable sections is dropped', noSections.length === 0);
}

// ── Selection ────────────────────────────────────────────
{
  const parsed = parseChangelogPayload(PAYLOAD);
  const newer = selectChangelogReleases(parsed, '0.42.0');
  check('newer than the installed build are shown, newest first',
    newer.mode === 'newer' && newer.releases.map(r => r.version).join(',') === '0.44.0,0.43.1',
    `${newer.mode}: ${newer.releases.map(r => r.version).join(',')}`);

  const current = selectChangelogReleases(parsed, '0.44.0');
  check("the installed build's own notes are shown when up to date",
    current.mode === 'current' && current.releases[0]?.version === '0.44.0',
    `${current.mode}: ${current.releases.map(r => r.version).join(',')}`);

  const none = selectChangelogReleases(parsed, '0.50.0');
  check('nothing is shown for a version the file does not know',
    none.mode === 'none' && none.releases.length === 0, none.mode);

  const junk = selectChangelogReleases(parsed, 'not-a-version');
  check('an unreadable installed version falls back to the newest entry',
    junk.mode === 'current' && junk.releases[0]?.version === '0.44.0', junk.mode);

  const many = Array.from({ length: 30 }, (_, i) =>
    RELEASE(`1.0.${i}`, '2026-11-20', [`item ${i}`]));
  const capped = selectChangelogReleases(many, '0.0.1');
  check('the viewer caps the number of newer releases',
    capped.releases.length === CHANGELOG_MAX_VIEW_RELEASES,
    `${capped.releases.length}`);

  check('sorting is newest first',
    sortReleasesNewestFirst([RELEASE('0.9.0', 'x', ['a']), RELEASE('0.10.0', 'x', ['b'])])
      .map(r => r.version).join(',') === '0.10.0,0.9.0');
}

// ── Fetch ────────────────────────────────────────────────
function fakeFetch(text, { status = 200, headers = {} } = {}) {
  const calls = [];
  const impl = (url, options, timeoutMs, consume) => {
    calls.push({ url, options, timeoutMs });
    return Promise.resolve(consume(new Response(text, { status, headers })));
  };
  impl.calls = calls;
  return impl;
}

{
  const impl = fakeFetch(JSON.stringify(PAYLOAD));
  const res = await fetchChangelog({ url: 'https://example.test/changelog.json', fetchImpl: impl });
  check('a good fetch parses the releases',
    res.ok === true && res.releases.length === 3, JSON.stringify(res));
  const call = impl.calls[0];
  check('the request is a bare GET with no credentials or body',
    call.url === 'https://example.test/changelog.json'
      && call.options.method === 'GET'
      && call.options.headers.Accept === 'application/json'
      && !call.options.headers.Authorization
      && !call.options.body && !call.options.credentials,
    JSON.stringify(call.options));
  check('the timeout is the changelog timeout',
    call.timeoutMs === 8000, String(call.timeoutMs));

  check('an empty URL is unconfigured',
    (await fetchChangelog({ url: '', fetchImpl: impl })).reason === 'unconfigured');

  check('a non-2xx response is an http error',
    (await fetchChangelog({ url: 'x', fetchImpl: fakeFetch('no', { status: 404 }) })).reason === 'http');

  check('invalid JSON is a parse error',
    (await fetchChangelog({ url: 'x', fetchImpl: fakeFetch('{not json') })).reason === 'parse');
  check('a wrong schema is a parse error',
    (await fetchChangelog({
      url: 'x', fetchImpl: fakeFetch(JSON.stringify({ schemaVersion: 2, releases: [] })),
    })).reason === 'parse');

  check('an oversized body is a size error',
    (await fetchChangelog({
      url: 'x',
      fetchImpl: fakeFetch('x'.repeat(CHANGELOG_MAX_BYTES + 1)),
    })).reason === 'size');
  check('an oversized content-length is a size error',
    (await fetchChangelog({
      url: 'x',
      fetchImpl: fakeFetch('{}', { headers: { 'content-length': String(CHANGELOG_MAX_BYTES + 1) } }),
    })).reason === 'size');

  check('a timeout is reported as timeout',
    (await fetchChangelog({
      url: 'x', fetchImpl: () => Promise.reject(new StashError('late', 'timeout')),
    })).reason === 'timeout');
  check('a network failure is reported as network',
    (await fetchChangelog({
      url: 'x', fetchImpl: () => Promise.reject(new Error('offline')),
    })).reason === 'network');

  check('every failure has user-facing text',
    ['timeout', 'http', 'parse', 'size', 'network'].every(r => changelogFailureText(r).length > 0)
      && changelogFailureText('unconfigured') === '');
}

// ── Publisher helpers ────────────────────────────────────
{
  const draft = [
    'Prose that is ignored.',
    '## New',
    '- One   new thing',
    '- Another new thing',
    '',
    '## Fixes',
    '- A fix',
    '-',
    'not a bullet',
  ].join('\n');
  const sections = parseDraft(draft);
  check('the draft parser keeps headings and bullets only',
    sections.length === 2 && sections[0].title === 'New'
      && sections[0].items.join('|') === 'One new thing|Another new thing'
      && sections[1].items.join('|') === 'A fix',
    JSON.stringify(sections));

  const loose = parseDraft('- before any heading\n## Later\n- after');
  check('a bullet before a heading lands under Changes',
    loose.length === 2 && loose[0].title === 'Changes' && loose[1].title === 'Later',
    JSON.stringify(loose));

  const empty = parseDraft('## Nothing\n\nprose only');
  check('an empty section is dropped', empty.length === 0);

  const body = renderReleaseBody({ sections });
  check('the release body renders Markdown sections',
    body === '## New\n\n- One new thing\n- Another new thing\n\n## Fixes\n\n- A fix\n',
    JSON.stringify(body));

  const base = { schemaVersion: 1, releases: [RELEASE('0.43.1', '2026-11-08', ['old'])] };
  const added = addRelease(base, RELEASE('0.44.0', '2026-11-20', ['new']));
  check('a new release is inserted newest first',
    added.ok === true && added.payload.releases.map(r => r.version).join(',') === '0.44.0,0.43.1',
    added.ok ? added.payload.releases.map(r => r.version).join(',') : added.errors.join(' | '));

  const refused = addRelease(base, RELEASE('0.43.1', '2026-11-20', ['again']));
  check('an existing version is refused without --replace', refused.ok === false);
  const replaced = addRelease(base, RELEASE('0.43.1', '2026-11-20', ['again']), { replace: true });
  check('--replace overwrites the entry',
    replaced.ok === true && replaced.payload.releases[0].sections[0].items[0] === 'again');

  const validated = validateChangelogPayload(added.payload);
  check('the publisher output passes strict validation', validated.ok === true,
    validated.errors.join(' | '));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
