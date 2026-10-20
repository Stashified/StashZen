/**
 * usePagedList re-entrancy probe.
 *
 * The defect this pins was reported from the TV (2026-10-20): back out of a
 * performer page after scrolling deep into the listing and the grid says
 * "40 performers" instead of "40 of 1,892 performers", and nothing loads past
 * page 1.
 *
 * Two triggers can ask for the next page in the same tick. On every grid that
 * is the sentinel observer (a page-1 render whose sentinel is already inside
 * the 400px rootMargin) racing a focus restore, which pages the listing
 * forward to the card Back should land on (utils/focus.js). The guard used to
 * be `loadingMore`, which is React state: the second call in the same tick
 * sees the old value and fetches the same page too. Both callers receive the
 * same rows (the list cache shares the in-flight request), the first appends
 * them, and the second finds no new ids — which is the hook's "no progress"
 * stop. It then rewrites the total to the rows held at that moment and marks
 * the list exhausted, so the count line collapses to "40 performers" and the
 * listing can never page again.
 *
 * The driver reproduces the two-trigger tick directly rather than hoping the
 * TV's timing shows up in Firefox: it calls `loadMore()` twice from one
 * effect, which is exactly what the observer plus the restore do to this
 * hook. Red control: without the ref guard this reports three failures.
 *
 * Not covered here: which trigger wins in the real app. That is timing, and
 * the guard makes the answer not matter.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useRef } from 'react';
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

// The probe's live listing, refreshed on every render. The driver reads it
// from outside React, so it can call `loadMore` the way the sentinel does.
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

  // The other half of the TV report: once stopped, nothing could page it
  // again. After the guard, the same trigger still reaches page 3.
  latest?.loadMore();
  const third = await waitFor(() => latest && latest.items.length === 100, 8000);
  check('L5 a later trigger still pages forward', third,
    `${latest?.items.length} rows, total ${latest?.total}`);
  check('L5 …and the short last page ends the listing',
    latest?.exhausted === true && latest?.total === 100,
    `exhausted ${latest?.exhausted}, total ${latest?.total}`);
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

createRoot(root).render(<Probe />);

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
