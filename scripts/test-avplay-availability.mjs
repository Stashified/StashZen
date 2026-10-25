#!/usr/bin/env node
/**
 * test-avplay-availability.mjs — how the app finds out whether a panel has
 * AVPlay, and what it does when the answer is no.
 *
 *   node scripts/test-avplay-availability.mjs
 *
 * The load is attempted once per session and its result — present or absent —
 * is kept. "Absent" is a normal answer: every scene then plays on the browser,
 * and re-probing the WebAPI script per scene would add a measured 1.5 s stall.
 */

import {
  avplayNow, ensureAvplay, resetAvplayProbe,
} from '../src/utils/avplayAvailability.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A document whose injected scripts can be made to load, fail, or hang. */
function fakeDoc({ onInject } = {}) {
  const doc = {
    head: {
      appendChild(el) {
        doc.appended.push(el);
        onInject?.(el, doc);
      },
    },
    appended: [],
    createElement(tag) {
      return { tag, src: '', async: false, onload: null, onerror: null };
    },
  };
  return doc;
}

// ── The live object, when it is already there ────────────
{
  const avplay = { version: 1 };
  const win = { webapis: { avplay } };
  check('a present AVPlay is found without loading anything',
    avplayNow(win) === avplay);
  check('a panel with no webapis answers null', avplayNow({}) === null);
  check('a throwing webapis answers null',
    avplayNow({ get webapis() { throw new Error('blocked'); } }) === null);
}

// ── Already present: no script injection ─────────────────
{
  resetAvplayProbe();
  const avplay = { version: 2 };
  const doc = fakeDoc();
  const out = await ensureAvplay({ doc, win: { webapis: { avplay } } });
  check('an already-present AVPlay resolves to itself', out === avplay);
  check('no script is injected in that case', doc.appended.length === 0);
}

// ── Not present: inject, load, find it ───────────────────
{
  resetAvplayProbe();
  const avplay = { version: 3 };
  const win = {};
  const doc = fakeDoc({
    onInject(el) {
      check('the Tizen WebAPI script path is used', /\$WEBAPIS\/webapis\/webapis\.js$/.test(el.src));
      win.webapis = { avplay };
      el.onload();
    },
  });
  const out = await ensureAvplay({ doc, win });
  check('a loaded script yields the AVPlay object', out === avplay);

  const again = await ensureAvplay({ doc, win });
  check('the successful probe is cached', again === avplay);
  check('and the script is injected once', doc.appended.length === 1);
}

// ── Missing panel: resolve null, and do not retry ────────
{
  resetAvplayProbe();
  let injected = 0;
  const doc = fakeDoc({
    onInject(el) { injected += 1; el.onerror(); },
  });
  const out = await ensureAvplay({ doc, win: {} });
  check('a script that fails to load resolves null', out === null);
  const again = await ensureAvplay({ doc, win: {} });
  check('the null answer is cached', again === null);
  check('and is not re-probed per scene', injected === 1);
}

// ── A script that never answers is bounded by the timeout ─
{
  resetAvplayProbe();
  const doc = fakeDoc({ onInject() { /* never calls back */ } });
  const started = Date.now();
  const out = await ensureAvplay({ doc, win: {}, timeoutMs: 30 });
  const elapsed = Date.now() - started;
  check('a hanging load resolves null', out === null);
  check('within the timeout', elapsed >= 20 && elapsed < 500, `${elapsed} ms`);
}

// ── No document at all (unit tests, SSR) ─────────────────
{
  resetAvplayProbe();
  const out = await ensureAvplay({ doc: null, win: {} });
  check('no document resolves null', out === null);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
