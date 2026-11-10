#!/usr/bin/env node
/**
 * test-connection-health.mjs: which failures count as "the server is down"
 *
 *   node scripts/test-connection-health.mjs
 *
 * Only an unreachable server counts. A rejected API key, a bad query or an
 * aborted request are all answers, and turning any of them into a connection
 * warning would tell the user to check the network when the real fix is
 * Settings.
 */

import {
  noteQueryResult, getConnectionState, subscribeConnection,
  noteSourceChanged, getConnectionGeneration,
} from '../src/utils/connectionHealth.js';
import { setSettings } from '../src/utils/settings.js';

let failed = 0;
let passed = 0;

function check(label, pass, detail = '') {
  if (pass) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`);
  }
}

const err = (code, name = 'StashError') => Object.assign(new Error(`boom ${code}`), { code, name });

// A source change retires the answers in flight and starts empty.
const reset = () => noteSourceChanged();

// Notifications are the UI's only wake-up, so each transition must fire once
// and a repeated verdict must not re-render the banner.
let notified = 0;
const off = subscribeConnection(() => { notified += 1; });

reset();
check('a fresh start is not down', getConnectionState().down === false);

noteQueryResult(err('network'));
check('a network failure reports the server down', getConnectionState().down === true);
check('...carrying its message', getConnectionState().message === 'boom network');
check('...and notifying once', notified === 1, `notified=${notified}`);

noteQueryResult(err('network'));
check('the same verdict again does not notify', notified === 1, `notified=${notified}`);

noteQueryResult(err('timeout'));
check('a timeout is down too', getConnectionState().down === true);
check('...and the newer message wins', getConnectionState().message === 'boom timeout');
check('...with a notification', notified === 2, `notified=${notified}`);

noteQueryResult(null);
check('one success clears it', getConnectionState().down === false);
check('...and notifies', notified === 3, `notified=${notified}`);

for (const code of ['http', 'graphql', 'config', 'parse']) {
  noteQueryResult(err(code));
  check(`a ${code} failure is not a connection problem`, getConnectionState().down === false);
}

noteQueryResult(err(undefined, 'AbortError'));
check('an aborted request is not a failure', getConnectionState().down === false);
check('none of those notified', notified === 3, `notified=${notified}`);

noteQueryResult(err('network'));
off();
noteQueryResult(null);
check('unsubscribing stops the notifications', notified === 4, `notified=${notified}`);

reset();
check('a reset returns to the empty state', getConnectionState().down === false
  && getConnectionState().message === '');

// The clear lives in the source change itself: Test mode and the setup screen
// send no request that could ever clear a stale verdict.
noteQueryResult(err('network'));
check('the next outage is raised', getConnectionState().down === true);
reset();
check('a source change clears a verdict with no request', getConnectionState().down === false);

// A request answers for the source it was sent to: a late answer from the old
// one must not raise the banner on the new source.
const before = getConnectionGeneration();
const staleGen = getConnectionGeneration();
noteSourceChanged();
noteQueryResult(err('network'), staleGen);
check('an answer from before a source change is ignored', getConnectionState().down === false);
noteQueryResult(err('network'), getConnectionGeneration());
check('...while a current one still counts', getConnectionState().down === true);
check('a source change moves the generation', getConnectionGeneration() > before);
noteQueryResult(null);

// The bump has to happen where the source is saved, not in App's effect:
// the new source's first requests start before that effect runs.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const savedGen = getConnectionGeneration();
setSettings({ stashUrl: 'http://127.0.0.1:1' });
check('saving a new endpoint moves the generation', getConnectionGeneration() > savedGen);
const sameGen = getConnectionGeneration();
setSettings({ seekStep: 15 });
check('...and a setting that is not the source does not',
  getConnectionGeneration() === sameGen);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
