/**
 * Headless driver for the data-layer fixes; the observable is not a screen,
 * and each bug left the UI looking fine.
 *
 *   D1–D5  Test mode's sorts. Fields the mock rows lacked (`duration` vs
 *          `durationSeconds`) made `a[field] - b[field]` compare undefined, so
 *          the comparator returned 0 and the list kept its order, a control
 *          that appears to work. `random` had the reverse: a real random
 *          comparator reorders per call, so paging duplicates and drops rows.
 *   D6     `usePlayQueue` at a page boundary. Stash's ordering can shift
 *          between requests, so the next page can repeat rows the queue holds;
 *          returning false stranded playback there.
 *   D7     `listCache`'s in-flight slot after clear(): the old request's settle
 *          must delete its own promise, not whatever is under the key now.
 *   D8     `dataSourceKey` must change with the API key (a regenerated token
 *          otherwise left every module cache with the old credential's
 *          answers) and must not contain the secret.
 *   D9     The folder picker: galleries' `parent_folder` is a folder id, and
 *          the fake answers `findFolders` so labels can be checked against
 *          real path shapes.
 *   D10    A studio's `parents` are studios, not tags.
 *
 * Needs no App or page; the services and hooks are the shipped modules.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef } from 'react';
import { setSettings, dataSourceKey, getSettings } from '../../src/utils/settings.js';
import { fetchVideos } from '../../src/utils/videoService.js';
import { fetchPerformers } from '../../src/utils/performerService.js';
import { fetchMarkers } from '../../src/utils/markerService.js';
import { fetchStudios } from '../../src/utils/studioService.js';
import { createListCache } from '../../src/utils/listCache.js';
import { entitySource } from '../../src/utils/filterCriteria.js';
import { searchEntities } from '../../src/utils/entitySearch.js';
import { usePlayQueue } from '../../src/hooks/usePlayQueue.js';
import { mockComparator } from '../../src/utils/mockSort.js';

const PORT = window.__PORT__;
const LIVE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const nonIncreasing = (xs) => {
  for (let i = 1; i < xs.length; i++) {
    if (!(xs[i - 1] >= xs[i])) return false;
  }
  return true;
};

// ── D1–D5: Test mode's sorts ────────────────────────────────

async function runMockSorts() {
  setSettings({ useMock: true, stashUrl: LIVE, stashKey: 'harness' });

  const { videos } = await fetchVideos({ sort: 'duration', order: 'desc', limit: 48 });
  const durations = videos.map(v => v.durationSeconds);
  check('D1 Test mode sorts videos by duration, not by nothing',
    durations.length > 1 && nonIncreasing(durations)
      && new Set(durations).size > 1,
    `${durations.slice(0, 4).join(', ')} …`);

  const { videos: byRes } = await fetchVideos({ sort: 'resolution', order: 'desc', limit: 48 });
  const heights = byRes.map(v => v.height);
  check('D2 Test mode sorts videos by resolution (the sort name is not the field name)',
    heights.length > 1 && nonIncreasing(heights)
      && heights[0] === Math.max(...heights),
    heights.slice(0, 6).join(', '));

  // `random` must be a *stable* permutation: paging takes slices of one
  // ordering, and a per-call re-rank duplicates and drops rows at the boundary.
  //
  // Called directly, not through two fetches: the same request twice is a
  // listCache hit and would pass on a `Math.random()` implementation. The rows
  // come from a real test-mode fetch, so the ids are the listing's.
  const { videos: naturalRows } = await fetchVideos({ sort: 'created_at', order: 'desc', limit: 48 });
  const rank = mockComparator('random', 'desc');
  const ids1 = [...naturalRows].sort(rank).map(v => v.id).join(',');
  const ids2 = [...naturalRows].sort(rank).map(v => v.id).join(',');
  const natural = naturalRows.map(v => v.id).join(',');
  check('D3 "random" is one stable permutation, not a reshuffle per call',
    ids1 === ids2 && ids1 !== natural,
    ids1 === ids2 ? (ids1 === natural ? 'stable but never shuffled' : 'stable') : 'two different orders');

  const { performers } = await fetchPerformers({ sort: 'height', order: 'desc', limit: 40 });
  const cm = performers.map(p => p.height_cm);
  check('D4 Test mode sorts performers by height (height → height_cm)',
    cm.length > 1 && nonIncreasing(cm) && cm[0] === Math.max(...cm),
    cm.slice(0, 6).join(', '));

  // Markers sort on raw fields the normalised row lacks, so the observable is
  // id order; a no-op comparator leaves the fixture order untouched.
  const { markers: mDur, total: mTotal } = await fetchMarkers({ sort: 'duration', order: 'desc', limit: 60 });
  const { markers: mNat } = await fetchMarkers({ sort: 'title', order: 'asc', limit: 60 });
  check('D5 Test mode sorts markers by duration (the mock rows carry it at all)',
    mTotal === 60 && mDur.map(m => m.id).join(',') !== mNat.map(m => m.id).join(','),
    `${mDur.slice(0, 4).map(m => m.id).join(', ')} …`);

  const { studios } = await fetchStudios({ sort: 'tag_count', order: 'desc', limit: 20 });
  const tagCounts = studios.map(s => s.tag_count);
  check('D5b Test mode sorts studios by tag count without undefined comparisons',
    studios.length > 1 && nonIncreasing(tagCounts)
      && tagCounts[0] === Math.max(...tagCounts),
    tagCounts.join(', '));

  setSettings({ useMock: false, stashUrl: LIVE, stashKey: 'harness' });
}

// ── D6: the queue at a page boundary ────────────────────────

function QueueProbe() {
  const callsRef = useRef(0);
  const queue = useMemo(() => ({
    items: [{ id: 'a' }, { id: 'b' }],
    total: 5,
    page: 1,
    startIndex: 1,
    fetchPage: async (page) => {
      callsRef.current++;
      // Delayed so the mount-time extension is in flight when `goNext`
      // advances, the report's shape. Waiting first would let `goNext` start
      // a second extension asking the page after the duplicate, which advances
      // even on the shipped bug.
      await sleep(200);
      // Page 2 repeats the rows the queue holds (Stash's ordering shifted);
      // page 3 has new rows, page 4 ends the five-item listing.
      if (page === 2) return { items: [{ id: 'a' }, { id: 'b' }], total: 5 };
      if (page === 3) return { items: [{ id: 'c' }, { id: 'd' }], total: 5 };
      if (page === 4) return { items: [{ id: 'e' }], total: 5 };
      return { items: [], total: 5 };
    },
  }), []);
  const q = usePlayQueue(queue);
  const latest = useRef(q);
  latest.current = q;
  useEffect(() => {
    window.__queueGo = async () => {
      const moved = await latest.current.goNext();
      return { moved, calls: callsRef.current };
    };
    window.__queueIds = () => latest.current.items.map(i => i.id).join(',');
    // Read after a render: `current` is `items[index]`, so the calling closure
    // still holds the old index.
    window.__queueNow = () => latest.current.current?.id;
    window.__queueCalls = () => callsRef.current;
  }, []);
  return <span data-current>{q.current?.id || ''}</span>;
}

async function runQueue() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<QueueProbe />);
  // The cursor sits one row from the page end, so the mount effect asks for
  // page 2 itself; `goNext` joins that in-flight extension.
  await sleep(60);
  const before = window.__queueCalls();
  const out = await window.__queueGo();
  await sleep(700);            // the follow-up extension for page 4 settles
  const ids = window.__queueIds();
  check('D6 an all-duplicate page is skipped, not treated as the end of the queue',
    out.moved === true && ids === 'a,b,c,d,e' && window.__queueNow() === 'c',
    `items=${ids}, moved=${out.moved}, current=${window.__queueNow()}, ` +
    `fetches=${before}→${window.__queueCalls()}`);
  check('D6 ...with one request per page and no loop on a server that repeats itself',
    window.__queueCalls() >= 2 && window.__queueCalls() <= 3,
    `${window.__queueCalls()} page fetches (the shipped bug stops after the one ` +
    'duplicate page; a repeat-forever server would never stop)');
  root.unmount();
  host.remove();
}

// ── D7: the cache's in-flight slot after clear() ────────────

async function runListCache() {
  const cache = createListCache();
  let resolveOld;
  const old = cache.get('same-key', () => new Promise((r) => { resolveOld = r; }));
  cache.clear();                          // the tab-switch invalidation

  let newCalls = 0;
  let resolveNew;
  const fresh = cache.get('same-key', () => {
    newCalls++;
    return new Promise((r) => { resolveNew = r; });
  });

  resolveOld('old');
  await old;
  await sleep(0);

  // A third caller while the new request is in flight must join it. An
  // unconditional delete had the old promise's settle remove the new slot.
  let thirdCalls = 0;
  const third = cache.get('same-key', () => {
    thirdCalls++;
    return Promise.resolve('third');
  });
  check('D7 an old request settling after clear() does not evict the new in-flight request',
    thirdCalls === 0,
    `third caller started its own request: ${thirdCalls > 0}`);

  resolveNew('new');
  await Promise.all([fresh, third]);
  await sleep(0);
  // And after it lands, the value is remembered rather than refetched.
  let afterCalls = 0;
  const after = await cache.get('same-key', () => { afterCalls++; return Promise.resolve('after'); });
  check('D7 ...and the new answer is what gets cached',
    afterCalls === 0 && after === 'new', `after=${after}, refetched=${afterCalls > 0}, newCalls=${newCalls}`);
}

// ── D8: the source key and the secret ───────────────────────

async function runSourceKey() {
  setSettings({ useMock: false, stashUrl: LIVE, stashKey: 'harness-one' });
  const one = dataSourceKey(getSettings());
  setSettings({ stashKey: 'harness-two' });
  const two = dataSourceKey(getSettings());
  setSettings({ stashKey: 'harness-one' });
  const oneAgain = dataSourceKey(getSettings());

  check('D8 rewriting the API key changes the data-source identity',
    one !== two && one === oneAgain, `${one} → ${two} → ${oneAgain}`);
  check('D8 ...without putting the secret in the string',
    !one.includes('harness-one') && !two.includes('harness-two')
      && /^live:http:\/\/127\.0\.0\.1:\d+:k[0-9a-f]{16}$/.test(one),
    one);
  setSettings({ stashKey: 'harness' });
}

// ── D9/D10: the picker's folders and a studio's parents ─────

async function runPicker() {
  check('D10 a studio\'s `parents` resolve to studios, not tags',
    entitySource('parents', 'StudioFilterType') === 'studios'
      && entitySource('parents', 'TagFilterType') === 'tags',
    `${entitySource('parents', 'StudioFilterType')} / ${entitySource('parents', 'TagFilterType')}`);

  const rows = await searchEntities('folders', '', 10);
  const labels = rows.map(r => r.label);
  check('D9 the folder picker finds folders and names them by their path tail',
    rows.length === 3
      && labels[0] === 'Studio Alpha/Photos/2002'
      && labels[2] === 'library/Summer Shoot/Country House',
    labels.join(' | '));
}

// ── Driver plumbing ─────────────────────────────────────────

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

async function run() {
  await runMockSorts();
  await runQueue();
  await runListCache();
  await runSourceKey();
  await runPicker();
}

run()
  .then(finish)
  .catch(async (e) => {
    results.push({
      name: 'driver crashed',
      pass: false,
      detail: (e && e.stack) || String(e),
    });
    await finish();
  });
