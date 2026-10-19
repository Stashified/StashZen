#!/usr/bin/env node
/**
 * test-key-routing.mjs — the player's key map
 *
 *   node scripts/test-key-routing.mjs
 *
 * The map that decides what a remote key does in the player is the most
 * intricate table in the app: four states (no rail, rail up, foreign dialog,
 * one-scene queue) times every key, and the prevent/stop flags matter as much
 * as the action — a wrongly consumed ←/→ breaks spatial nav, and an
 * unconsumed arrow outside the rail drops the cursor onto a rail the user
 * never opened. Back is the one key whose meaning also depends on whether the
 * controls are on screen: the bar goes first, the player on the press after.
 * Off-device the harness can only prove the mapping, not what a given TV's
 * remote emits, so the mapping itself is pinned here directly.
 *
 * No framework, same as test-play-queue.mjs and test-progress-reporter.mjs.
 */

import { routePlayerKey } from '../src/components/player/keyRouting.js';

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ev = (key, keyCode) => ({ key, keyCode });

// `controlsVisible: false` is the resting state this file's no-rail checks were
// written against: the bar auto-hides after three seconds, so "Back closes the
// player" is the press a user makes on a hidden bar. The visible-bar layering
// has its own context and its own checks below.
const NO_RAIL = {
  railHoldsFocus: false, foreignDialog: false, singleScene: false, controlsVisible: false,
};
const VISIBLE = { ...NO_RAIL, controlsVisible: true };
const RAIL = { ...NO_RAIL, railHoldsFocus: true, controlsVisible: true };
const SINGLE = { ...NO_RAIL, singleScene: true };
const FOREIGN = { ...NO_RAIL, foreignDialog: true };

const route = (e, ctx = NO_RAIL) => routePlayerKey(e, ctx);
const is = (e, ctx, action, prevent, stop) => {
  const r = route(e, ctx);
  return eq(r, { action, prevent, stop });
};
const show = (r) => JSON.stringify(r);

// ── A foreign dialog owns every key ─────────────────────────
// The listener is first in the capture phase, so returning untouched is the
// yield. Consuming anything here would make the marker form and the detail
// page look dead.
for (const e of [ev('Enter', 13), ev('Escape', 27), ev(' ', 32), ev('ArrowLeft', 37), ev('a', 65)]) {
  check(`foreign dialog yields ${e.key || e.keyCode}`,
    is(e, FOREIGN, 'yield', false, false), show(route(e, FOREIGN)));
}

// ── Rail up: the cursor owns ←/→ and Enter ─────────────────
check('rail: Space is instant transport', is(ev(' ', 32), RAIL, 'media', true, true));
check('rail: 415 is instant transport', is(ev('', 415), RAIL, 'media', true, true));
check('rail: 19 is instant transport', is(ev('', 19), RAIL, 'media', true, true));
check('rail: 10252 is instant transport', is(ev('', 10252), RAIL, 'media', true, true));
check('rail: ArrowUp steps back', is(ev('ArrowUp', 38), RAIL, 'step-prev', true, true));
check('rail: ArrowDown steps forward', is(ev('ArrowDown', 40), RAIL, 'step-next', true, true));
check('rail: ArrowUp by code alone steps back', is(ev('', 38), RAIL, 'step-prev', true, true));
check('rail: Escape leaves the rail', is(ev('Escape', 27), RAIL, 'leave-rail', true, true));
check('rail: Backspace leaves the rail', is(ev('Backspace', 8), RAIL, 'leave-rail', true, true));
check('rail: Tizen Back leaves the rail', is(ev('', 10009), RAIL, 'leave-rail', true, true));
check('rail: ArrowLeft is passed to the rail', is(ev('ArrowLeft', 37), RAIL, 'rail-pass', false, false));
check('rail: ArrowRight is passed to the rail', is(ev('ArrowRight', 39), RAIL, 'rail-pass', false, false));
check('rail: Enter activates the focused button', is(ev('Enter', 13), RAIL, 'rail-pass', false, false));
check('rail: 412 is passed to the rail', is(ev('', 412), RAIL, 'rail-pass', false, false));

// ── No rail: the player owns everything ────────────────────
check('no rail: Escape closes', is(ev('Escape', 27), NO_RAIL, 'close', true, true));
check('no rail: Backspace closes', is(ev('Backspace', 8), NO_RAIL, 'close', true, true));
check('no rail: Tizen Back closes', is(ev('', 10009), NO_RAIL, 'close', true, true));
check('no rail: 413 closes', is(ev('', 413), NO_RAIL, 'close', true, true));

// ── No rail, bar up: Back puts the bar away first ──────────
// The user's 2026-10-18 report: with the controls on screen, Back hid nothing
// and closed the player, losing the playback they were only trying to uncover.
// Back is now one level up in the bar too; the *next* Back closes (the checks
// above, on a hidden bar).
for (const e of [ev('Escape', 27), ev('Backspace', 8), ev('', 10009), ev('', 413)]) {
  check(`no rail, bar up: ${e.key || e.keyCode} hides the bar`,
    is(e, VISIBLE, 'hide-controls', true, true), show(route(e, VISIBLE)));
}
check('no rail, bar up: Space still toggles playback',
  is(ev(' ', 32), VISIBLE, 'media', true, true));
check('no rail, bar up, single scene: Back still hides the bar',
  is(ev('Backspace', 8), { ...VISIBLE, singleScene: true }, 'hide-controls', true, true));
check('no rail: Space toggles playback', is(ev(' ', 32), NO_RAIL, 'media', true, true));
check('no rail: 10252 toggles playback', is(ev('', 10252), NO_RAIL, 'media', true, true));
check('no rail: Enter reveals the rail', is(ev('Enter', 13), NO_RAIL, 'reveal-rail', true, true));
check('no rail: ArrowLeft skims back', is(ev('ArrowLeft', 37), NO_RAIL, 'skim-back', true, true));
check('no rail: 412 skims back', is(ev('', 412), NO_RAIL, 'skim-back', true, true));
check('no rail: ArrowRight skims forward', is(ev('ArrowRight', 39), NO_RAIL, 'skim-forward', true, true));
check('no rail: 417 skims forward', is(ev('', 417), NO_RAIL, 'skim-forward', true, true));

// ↑/↓ step a queue, and only raise the rail for a lone scene — where there is
// nothing to step to and doing nothing would read as a dropped key.
check('no rail, multi: ArrowUp steps back', is(ev('ArrowUp', 38), NO_RAIL, 'step-prev', true, true));
check('no rail, multi: ArrowDown steps forward', is(ev('ArrowDown', 40), NO_RAIL, 'step-next', true, true));
check('no rail, single: ArrowUp reveals the rail', is(ev('ArrowUp', 38), SINGLE, 'reveal-rail', true, true));
check('no rail, single: ArrowDown reveals the rail', is(ev('ArrowDown', 40), SINGLE, 'reveal-rail', true, true));

// Every key the player sees outside the rail is consumed, even ones it does
// not act on: the global handler's fallback would otherwise move the cursor.
check('no rail: an unhandled key is still stopped',
  is(ev('a', 65), NO_RAIL, 'none', false, true), show(route(ev('a', 65))));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
