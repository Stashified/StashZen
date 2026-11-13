/**
 * usePagedList re-entrancy probe.
 *
 * Two triggers can ask for the next page in one tick: the sentinel observer
 * (already inside its 400px rootMargin on a page-1 render) racing a focus
 * restore (utils/focus.js). The old guard was `loadingMore` React state, so
 * the second call saw the old value and fetched the same page too. Both got
 * the same rows (the list cache shares the in-flight request); the first
 * appended them, the second found no new ids and hit the "no progress" stop,
 * rewriting the total and marking the list exhausted, "40 performers",
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
 *
 * The third probe fails the new identity's page 1 after its retry budget. The
 * reset carries the outgoing rows forward while that page is fetched; if the
 * failure leaves them, every consumer hides the error (it renders only on an
 * empty list) and shows the replaced query's results under the new controls.
 * Red control: without the clear, L16 reports 40 rows still there.
 *
 * The fourth probe deletes a row from a two-page marker listing and pages on.
 * A delete shifts every later row up one, so the held rows stop ending on a
 * page boundary and page 3 starts at the old offset 80, silently skipping the
 * row that moved to 79. Red control: without the seam refetch, L20 misses
 * D-81 and the rows are not the server's.
 *
 * The fifth deletes while the next page is in flight. That page was requested
 * at the old offsets and lands after the shift; its rows still start at the
 * seam, so the seam has to move to the new boundary. Left at the delete count,
 * the refetch reseats a page whose rows are all held and the no-progress stop
 * ends the list at 79 rows.
 *
 * The sixth deletes a held row while a page-1 revalidation is in flight. Page 1
 * replaces the whole list, so the seam that delete recorded is spent when it
 * lands. Left set, the next loadMore asks for page 1 again, finds every row
 * held and ends the list at 40 of 99. Red control: without clearing the seam on
 * page-1 success, L29 asks page 1 and L30 reports 40 rows.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { usePagedList } from '../../src/hooks/usePagedList.js';
import { fetchPerformers } from '../../src/utils/performerService.js';
import { publishRowRemove } from '../../src/utils/rowPatches.js';
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

// ── Probe 3: a page 1 that fails after the identity changed (R2) ────
// A complete first listing, then an identity whose every page 1 rejects, with
// the retry budget's 3 s spacing. Controlled, so the timing is not a race.
const failProbe = { setKey: null, list: null };
const failRequests = [];

function failingFetch(key) {
  return (page) => {
    failRequests.push(`${key}:${page}`);
    if (key === 'BAD') return Promise.reject(new Error('probe failure'));
    // 40 rows and total 40: a fully loaded list, the case where `exhausted`
    // is true and even the "couldn't load more" line stays hidden.
    return Promise.resolve({ items: rowsFor('OK', 1), total: 40 });
  };
}

function FailProbe() {
  const [key, setKey] = useState('OK');
  failProbe.setKey = setKey;

  const list = usePagedList({
    fetchPage: failingFetch(key),
    requestKey: `fail-probe-${key}`,
  });
  failProbe.list = list;

  return <div data-probe-fail>{`${key}: ${list.items.length} of ${list.total}`}</div>;
}

// ── Probe 4: a delete in a paged listing (R3) ────────────
// A mutable array stands in for the server so the delete is real: removing a
// row shifts every later one up, exactly as findSceneMarkers would answer
// after App removed a marker. The listing is told the way App tells it.
const DEL_SIZE = 40;
const delServer = Array.from({ length: 100 }, (_, i) => ({ id: `D-${i + 1}` }));
const delRequests = [];
const delProbe = { list: null };

function delFetch(page) {
  delRequests.push(page);
  const start = (page - 1) * DEL_SIZE;
  return Promise.resolve({
    items: delServer.slice(start, start + DEL_SIZE).map(it => ({ ...it })),
    total: delServer.length,
  });
}

function DeleteProbe() {
  const list = usePagedList({
    fetchPage: delFetch,
    requestKey: 'delete-probe',
    entity: 'marker',
  });
  delProbe.list = list;
  return <div data-probe-delete>{`${list.items.length} of ${list.total}`}</div>;
}

// ── Probe 5: a delete while the next page is in flight (R4) ──
// The first page-2 request is held open, with its rows captured before the
// delete, so the landing page is exactly the stale-offset answer the seam
// advance has to absorb.
const RACE_SIZE = 40;
const raceServer = Array.from({ length: 100 }, (_, i) => ({ id: `R-${i + 1}` }));
const raceRequests = [];
let raceHeldResolver = null;
const raceProbe = { list: null };

function raceFetch(page) {
  raceRequests.push(page);
  const start = (page - 1) * RACE_SIZE;
  const rows = raceServer.slice(start, start + RACE_SIZE).map(it => ({ ...it }));
  const total = raceServer.length;
  if (page === 2 && !raceHeldResolver) {
    return new Promise((resolve) => {
      raceHeldResolver = () => resolve({ items: rows, total });
    });
  }
  return Promise.resolve({ items: rows, total });
}

function RaceProbe() {
  const list = usePagedList({
    fetchPage: raceFetch,
    requestKey: 'race-probe',
    entity: 'marker',
  });
  raceProbe.list = list;
  return <div data-probe-race>{`${list.items.length} of ${list.total}`}</div>;
}

// ── Probe 6: a delete during a page-1 revalidation (R5) ──
// The identity changes while 40 rows stay on screen as the seed, and the new
// page 1 is answered only when released, after one of those held rows was
// deleted. Page 1 then replaces the whole list, so the seam the delete
// recorded is spent.
const REVAL_SIZE = 40;

function makeRevalProbe(entity) {
  const server = Array.from({ length: 100 }, (_, i) => ({ id: `V-${i + 1}` }));
  const requests = [];
  let heldResolver = null;
  const probe = { key: 'A', list: null, setKey: null };

  function fetchPage(page) {
    requests.push(`${probe.key}:${page}`);
    const start = (page - 1) * REVAL_SIZE;
    const answer = () => ({
      items: server.slice(start, start + REVAL_SIZE).map(it => ({ ...it })),
      total: server.length,
    });
    if (probe.key === 'B' && page === 1 && !heldResolver) {
      // Rows are read at release time, from the server as it stands then: the
      // page already reflects the delete, which is the ordering that strands
      // the seam.
      return new Promise((resolve) => { heldResolver = () => resolve(answer()); });
    }
    return Promise.resolve(answer());
  }

  function Probe() {
    const [key, setKey] = useState('A');
    probe.key = key;
    probe.setKey = setKey;
    const list = usePagedList({
      fetchPage,
      requestKey: `reval-${entity}-${key}`,
      entity,
    });
    probe.list = list;
    return <div data-probe-reval={entity}>{`${key}: ${list.items.length} of ${list.total}`}</div>;
  }

  return { probe, server, requests, Probe, release: () => heldResolver?.() };
}

const revalControl = makeRevalProbe('reval-control');
const revalDelete = makeRevalProbe('reval-delete');

const ids = (list) => (list?.items || []).map(it => it.id).join(',');

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

  // A:2 is held open; do not await, the promise is the response and stays in
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
  const settleA = heldResolvers.get('A:2');
  check('L9 the in-flight A:2 request can be settled', typeof settleA === 'function',
    `resolvers: ${[...heldResolvers.keys()].join(' ') || '(none)'}`);
  settleA?.({ items: rowsFor('A', 2), total: KEY_TOTAL });
  // A missing resolver would leave this pending forever and hang the runner
  // before finish(), so the wait is bounded and reported.
  const aSettled = await Promise.race([
    aPending.then(() => true, () => true),
    sleep(3000).then(() => false),
  ]);
  check('L9 the settled A:2 request completes', aSettled,
    'aPending did not settle within 3 s');
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

  // ── R2: the new identity's page 1 exhausts its retry budget ──
  const okReady = await waitFor(
    () => failProbe.list?.items.length === 40 && !failProbe.list.loading,
  );
  check('L14 the first identity loads a complete page', okReady,
    failProbe.list ? `${failProbe.list.items.length} of ${failProbe.list.total}` : 'no listing');

  failProbe.setKey('BAD');
  // Two RETRY_DELAY_MS (3 s) waits after the first attempt.
  const failed = await waitFor(() => !!failProbe.list?.error, 12000);
  check('L15 a failed page 1 reports its error', failed, failProbe.list?.error || 'no error');
  check('L16 the replaced identity\'s rows are gone, so the error is visible',
    failProbe.list?.items.length === 0,
    `${failProbe.list?.items.length} rows left (red control: 40)`);
  check('L17 the carried count is cleared and the retry spinner is off',
    failProbe.list?.total === 0 && failProbe.list?.loading === false
      && failProbe.list?.retrying === false,
    `total ${failProbe.list?.total}, loading ${failProbe.list?.loading}, retrying ${failProbe.list?.retrying}`);

  // ── R3: delete a row, then page on ──
  const delFirst = await waitFor(() => delProbe.list?.items.length === 40 && !delProbe.list.loading);
  check('L18 the delete listing loads its first page', delFirst,
    `${delProbe.list?.items.length} rows`);
  delProbe.list?.loadMore();
  const delSecond = await waitFor(() => delProbe.list?.items.length === 80);
  check('L19 two pages are held before the delete', delSecond,
    `${delProbe.list?.items.length} rows, total ${delProbe.list?.total}`);

  // Delete D-6, the sixth row, from the server array and the listing.
  const [gone] = delServer.splice(5, 1);
  publishRowRemove('marker', gone.id);
  // The backfill runs on a timer; the seam row is the server's index 79, D-81.
  const backfilled = await waitFor(
    () => delProbe.list?.items.length === 80 && delProbe.list.items[79]?.id === 'D-81',
    3000,
  );
  check('L20 the delete refetches the seam instead of skipping the row that moved',
    backfilled,
    `${delProbe.list?.items.length} rows, last ${delProbe.list?.items[79]?.id}, requests ${delRequests.join(' ')}`);

  const expected = delServer.map(it => it.id).join(',');
  check('L21 the held rows are the server\'s, in order, with no hole',
    ids(delProbe.list) === delServer.slice(0, 80).map(it => it.id).join(','),
    `${delProbe.list?.items.length} rows held`);

  delProbe.list?.loadMore();
  const delAll = await waitFor(
    () => delProbe.list?.items.length === 99 && delProbe.list.exhausted,
    3000,
  );
  check('L22 paging on after the delete still reaches every remaining row',
    delAll && ids(delProbe.list) === expected,
    `${delProbe.list?.items.length} rows, total ${delProbe.list?.total}, last ${delProbe.list?.items[98]?.id}`);

  // ── R4: a delete while the next page is in flight ──
  const raceFirst = await waitFor(
    () => raceProbe.list?.items.length === 40 && !raceProbe.list.loading,
  );
  check('L23 the race listing holds its first page', raceFirst,
    `${raceProbe.list?.items.length} rows`);

  raceProbe.list?.loadMore();
  const raceStarted = await waitFor(() => raceRequests.includes(2), 3000);
  check('L24 the next page is in flight', raceStarted,
    `requests ${raceRequests.join(' ')}`);

  const [raceGone] = raceServer.splice(5, 1);
  publishRowRemove('marker', raceGone.id);
  raceHeldResolver?.();

  // The held page starts at the seam, so it bridges the shift and only the
  // moved row is missing; the seam refetch is what brings it in.
  const raceBackfilled = await waitFor(
    () => raceProbe.list?.items.length === 80 && raceProbe.list.items[79]?.id === 'R-81',
    3000,
  );
  check('L25 the landed page moves the seam, so the moved row still comes in',
    raceBackfilled,
    `${raceProbe.list?.items.length} rows, last ${raceProbe.list?.items[79]?.id}, `
      + `requests ${raceRequests.join(' ')}`);

  raceProbe.list?.loadMore();
  const raceAll = await waitFor(
    () => raceProbe.list?.items.length === 99 && raceProbe.list.exhausted,
    3000,
  );
  check('L26 paging on reaches every row, in order, after the in-flight delete',
    raceAll && ids(raceProbe.list) === raceServer.map(it => it.id).join(','),
    `${raceProbe.list?.items.length} rows, total ${raceProbe.list?.total}, `
      + `last ${raceProbe.list?.items[98]?.id}`);

  // ── R5: a delete during a page-1 revalidation ──
  // The control first, so the revalidation landing and paging on are known
  // good without a delete in the way.
  const cReady = await waitFor(
    () => revalControl.probe.list?.items.length === 40 && !revalControl.probe.list.loading,
  );
  revalControl.probe.setKey('B');
  const cHeld = await waitFor(() => revalControl.requests.includes('B:1'), 3000);
  const cCarried = cHeld && revalControl.probe.list?.items.length === 40;
  revalControl.release();
  const cLanded = await waitFor(
    () => revalControl.probe.list?.items.length === 40 && !revalControl.probe.list.loading,
  );
  revalControl.probe.list?.loadMore();
  const cPaged = await waitFor(() => revalControl.probe.list?.items.length === 80, 3000);
  check('L27 the carried rows survive the revalidation, and paging on reaches page 2',
    cReady && cCarried && cLanded && cPaged
      && revalControl.probe.list?.items[79]?.id === 'V-80',
    `${revalControl.probe.list?.items.length} rows, last ${revalControl.probe.list?.items[79]?.id}, `
      + `requests ${revalControl.requests.join(' ')}`);

  const dReady = await waitFor(
    () => revalDelete.probe.list?.items.length === 40 && !revalDelete.probe.list.loading,
  );
  revalDelete.probe.setKey('B');
  await waitFor(() => revalDelete.requests.includes('B:1'), 3000);
  // The delete lands while page 1 is held; the backfill it schedules is a
  // no-op during the hold, as on a TV.
  await sleep(80);
  const [revalGone] = revalDelete.server.splice(5, 1);
  publishRowRemove('reval-delete', revalGone.id);
  const dDropped = await waitFor(
    () => revalDelete.probe.list?.items.length === 39, 3000,
  );
  revalDelete.release();
  const dLanded = await waitFor(
    () => revalDelete.probe.list?.items.length === 40 && !revalDelete.probe.list.loading,
    3000,
  );
  check('L28 the fresh page 1 lands after the delete held it open',
    dReady && dDropped && dLanded && revalDelete.probe.list?.total === 99,
    `${revalDelete.probe.list?.items.length} of ${revalDelete.probe.list?.total}, `
      + `requests ${revalDelete.requests.join(' ')}`);

  const revalBefore = revalDelete.requests.length;
  revalDelete.probe.list?.loadMore();
  const revalAsked = await waitFor(
    () => revalDelete.requests.length > revalBefore, 3000,
  );
  const revalNext = revalDelete.requests.slice(revalBefore);
  check('L29 paging on asks for page 2, not the page 1 that replaced the list',
    revalAsked && revalNext.includes('B:2') && !revalNext.includes('B:1'),
    `asked ${revalNext.join(' ') || '(nothing)'}`);

  // Page 2 of the 99-row server starts at V-42 (V-6 was deleted), so the
  // eightieth held row is V-81.
  const revalPaged = await waitFor(
    () => revalDelete.probe.list?.items.length === 80, 3000,
  );
  check('L30 the list pages on with the deleted row gone and no hole',
    revalPaged
      && revalDelete.probe.list?.items[79]?.id === 'V-81'
      && !revalDelete.probe.list.items.some(it => it.id === revalGone.id),
    `${revalDelete.probe.list?.items.length} rows, last ${revalDelete.probe.list?.items[79]?.id}, `
      + `total ${revalDelete.probe.list?.total} (red control: 40 of 40)`);
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

createRoot(root).render(<>
  <Probe /><KeyProbe /><FailProbe /><DeleteProbe /><RaceProbe />
  <revalControl.Probe /><revalDelete.Probe />
</>);

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
