/**
 * usePagedList re-entrancy probe.
 *
 * Two triggers can ask for the next page in one tick: the sentinel observer
 * (already inside its 400px rootMargin on a page-1 render) racing a focus
 * restore (utils/focus.js). The old guard was `loadingMore` React state, so
 * the second call saw the old value and fetched the same page too. Both got
 * the same rows (the list cache shares the in-flight request); the first
 * appended them, the second found no new ids and hit the "no progress" stop,
 * rewriting the total and marking the list exhausted — "40 performers",
 * unable to page again.
 *
 * The driver calls `loadMore()` twice from one effect rather than relying on
 * Firefox timing. Red control: without the ref guard it reports three
 * failures.
 *
 * The second probe covers the guard's ownership: page 2 of one listing is
 * held in flight while the request identity changes, then the new listing asks
 * for its page 2. A boolean guard refuses and the new list never pages again.
 * Red control: `inFlightRef.current === true` makes L7 fail with B stuck at 40
 * rows. Which trigger wins in the real app is timing, and the guard makes it
 * moot.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { usePagedList } from '../../src/hooks/usePagedList.js';
import { fetchPerformers } from '../../src/utils/performerService.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* still settling */ }
    await sleep(25);
  }
  return false;
}

// The live listing, refreshed each render; the driver reads it outside React
// to call `loadMore` the way the sentinel does.
let latest = null;

function Probe() {
  const list = usePagedList({
    fetchPage: (page) =>
      fetchPerformers({ page, limit: 40 }).then(d => ({
        items: d.performers, total: d.total,
      })),
    requestKey: 'reentrancy-probe',
  });
  latest = list;

  const firedRef = useRef(false);
  useEffect(() => {
    if (list.loading || list.items.length !== 40 || firedRef.current) return;
    firedRef.current = true;
    // One tick, two triggers. The second must be a no-op.
    list.loadMore();
    list.loadMore();
  });

  return <div data-probe>{`${list.items.length} of ${list.total}`}</div>;
}

// ── Probe 2: identity change with a page in flight (R1) ────
// A controlled `fetchPage`, not the fake server: it needs one request held
// open across the identity change; a timeout would be a race.
const keyProbe = { setKey: null, list: null };
const keyRequests = [];
const heldResolvers = new Map();
const KEY_TOTAL = 60;

function rowsFor(key, page) {
  const start = (page - 1) * 40;
  const n = Math.max(0, Math.min(40, KEY_TOTAL - start));
  return Array.from({ length: n }, (_, i) => ({ id: `${key}-${start + i + 1}` }));
}

function controlledFetch(key) {
  return (page) => {
    keyRequests.push(`${key}:${page}`);
    if (key === 'A' && page === 2) {
      return new Promise(resolve => heldResolvers.set('A:2', resolve));
    }
    return new Promise(resolve => setTimeout(
      () => resolve({ items: rowsFor(key, page), total: KEY_TOTAL }), 10,
    ));
  };
}

function KeyProbe() {
  const [key, setKey] = useState('A');
  keyProbe.setKey = setKey;

  const list = usePagedList({
    fetchPage: controlledFetch(key),
    requestKey: `key-probe-${key}`,
  });
  keyProbe.list = list;

  return <div data-probe-key>{`${key}: ${list.items.length} of ${list.total}`}</div>;
}

async function run() {
  // The listing has 100 rows at 40 per page: page 2 is full, page 3 is short.
  const settled = await waitFor(() => latest && !latest.loading && latest.items.length > 40, 8000);
  check('L1 a second page settles after two triggers in one tick', settled,
    latest ? `${latest.items.length} rows, total ${latest.total}` : 'no listing');

  check('L2 exactly one page was appended, not two or none',
    latest?.items.length === 80,
    `${latest?.items.length} rows loaded`);
  check('L3 the count line keeps the server total',
    latest?.total === 100,
    `total ${latest?.total}${latest?.total === 40 ? ' (rewritten to the loaded rows)' : ''}`);
  check('L4 the listing is not declared exhausted',
    latest?.exhausted === false,
    `exhausted ${latest?.exhausted}`);

  // The other half of the report: once stopped nothing could page again. With
  // the guard, the same trigger still reaches page 3.
  latest?.loadMore();
  const third = await waitFor(() => latest && latest.items.length === 100, 8000);
  check('L5 a later trigger still pages forward', third,
    `${latest?.items.length} rows, total ${latest?.total}`);
  check('L5 …and the short last page ends the listing',
    latest?.exhausted === true && latest?.total === 100,
    `exhausted ${latest?.exhausted}, total ${latest?.total}`);

  // ── R1: an identity change while a page is in flight ──
  const aReady = await waitFor(
    () => keyProbe.list?.items.length === 40 && !keyProbe.list.loading,
  );
  check('L6 page 1 of listing A settles', aReady,
    keyProbe.list ? `${keyProbe.list.items.length} rows` : 'no listing');

  // A:2 is held open; do not await — the promise is the response and stays in
  // flight below.
  const aPending = keyProbe.list.loadMore();
  check('L7 A asks for its second page', keyRequests.includes('A:2'), keyRequests.join(' '));

  keyProbe.setKey('B');
  const bReady = await waitFor(
    () => keyProbe.list?.items.length === 40 && keyProbe.list.items[0]?.id?.startsWith('B-'),
  );
  check('L8 the new identity fetches its own page 1', bReady,
    keyProbe.list ? `${keyProbe.list.items.length} rows` : 'no listing');

  // The heart of R1: A's in-flight request belongs to a listing that no
  // longer exists; B must still be able to page.
  const bStarted = keyProbe.list.loadMore();
  check('L9 B starts its own second page while A is still in flight',
    keyRequests.filter(r => r === 'B:2').length === 1, keyRequests.join(' '));

  // Settle A while B's page is in flight: A's `finally` must clear only its
  // own slot, or B's is freed and a second trigger refetches B:2.
  heldResolvers.get('A:2')?.({ items: rowsFor('A', 2), total: KEY_TOTAL });
  await aPending;
  const secondTrigger = keyProbe.list.loadMore();

  // 60 rows is B's whole listing: page 1 (40) plus page 2 (20).
  const bPaged = await waitFor(() => keyProbe.list?.items.length === 60);
  check('L10 a stale in-flight request does not block the new identity', bPaged,
    `${keyProbe.list?.items.length} rows (red control: stuck at 40)`);
  check('L11 a started page resolves true — the restore\'s page budget',
    (await bStarted) === true);
  const second = await secondTrigger;
  check('L12 the stale settle frees nothing of B\'s — one request, second trigger false',
    second === false && keyRequests.filter(r => r === 'B:2').length === 1,
    `second trigger returned ${second}; requests ${keyRequests.join(' ')}`);

  await sleep(50);
  check('L13 the late page from the old identity never reaches the new list',
    keyProbe.list?.items.length === 60
      && keyProbe.list.items.every(i => String(i.id).startsWith('B-')),
    `${keyProbe.list?.items.length} rows, first ${keyProbe.list?.items[0]?.id}`);
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

const root = document.getElementById('root');
document.body.style.margin = '0';

// Before the render, so the first fetch already sees the fake endpoint.
setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(root).render(<><Probe /><KeyProbe /></>);

run()
  .then(finish)
  .catch(async (e) => {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    try { await finish(); } catch { /* nothing left to do */ }
  });
