/**
 * Headless verification driver for SceneDetailPage.
 *
 * Mounts the real component with the real hooks, and points the real service
 * layer at a fake GraphQL endpoint on the same origin. So the query text,
 * `runQuery`, `normalizeSceneDetail` and the mutation wrappers are all the
 * shipped code — only the server is a stand-in.
 *
 * The page is its own test driver: it runs the assertions and POSTs results.
 */

import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import SceneDetailPage from '../../src/pages/SceneDetailPage.jsx';
import { useKeyHandler } from '../../src/hooks/useKeyHandler.js';
import { useFocusable } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The card the user "pressed Enter on". Its rating is the display string the
// grid would carry, so the page paints 5 stars from this before the server
// answers 7 — which is what makes T1 a real assertion rather than a
// tautology.
const SCENE = {
  id: '4242',
  title: 'VERIFY — detail page harness',
  thumbnail: null,
  stream: `http://127.0.0.1:${PORT}/fake.mp4`,
  durationSeconds: 3725,
  width: 1920,
  height: 1080,
  resume_time: 0,
  play_count: 0,
  rating: '5.0',
};

let closedCount = 0;
let playedCount = 0;
// Every `onPlayAt` the page reports, in order. A marker press is only useful
// if the *timestamp* reaches App; "the player opened" would pass for 0.
const playedAt = [];
// Every `onActivityChange` the page reports. The resume reset is the only one
// App acts on, so this is where "the page told Home to prune the card" is
// observable from a driver that mounts the page on its own.
const activityEvents = [];

/**
 * Focusables living OUTSIDE the overlay. They are the control for the trap
 * test: they are registered in the same spatial-nav registry the detail page
 * uses, so "focus never lands on them" is evidence of a trap rather than of
 * there being nothing out there to find.
 *
 * They are in normal flow rather than `position: fixed` on purpose —
 * `findBestCandidate` skips any candidate with a null `offsetParent`, and a
 * fixed element has one.
 */
function Outside() {
  const a = useFocusable({ id: 'outside-top', zone: 'outside' });
  const b = useFocusable({ id: 'outside-bottom', zone: 'outside' });
  return (
    <div style={{ position: 'absolute', top: 0, left: 0 }}>
      <button ref={a.ref} id="outside-top" style={{ display: 'block' }}>outside top</button>
      <button ref={b.ref} id="outside-bottom" style={{ display: 'block' }}>outside bottom</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(true);

  // Spatial navigation is registered in App.jsx; without this nothing moves.
  useKeyHandler({
    onBack: () => { window.__backSeen = (window.__backSeen || 0) + 1; },
  });

  return (
    <>
      <Outside />
      {open && (
        <SceneDetailPage
          key={SCENE.id}
          scene={SCENE}
          onClose={() => { closedCount++; setOpen(false); }}
          onPlay={() => { playedCount++; }}
          onPlayAt={(seconds) => { playedAt.push(seconds); }}
          onActivityChange={(id, patch) => activityEvents.push({ id, patch })}
        />
      )}
    </>
  );
}

// ── Helpers the driver uses ─────────────────────────────────
const overlay = () => document.querySelector('[role="dialog"]');
const ratingStars = () => {
  const g = document.querySelector('[role="group"][aria-label^="Rating"]');
  const m = g && g.getAttribute('aria-label').match(/(\d+) of 10/);
  return m ? Number(m[1]) : null;
};
const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
// ActionButton renders icon + label and carries no aria-label, so find it by
// its text. `exact` avoids a label with a count matching a bare one.
const byText = (text, exact = false) =>
  [...document.querySelectorAll('button')].find(b => {
    const t = b.textContent.trim();
    return exact ? t === text : t.includes(text);
  });
// Read the count off the button itself rather than off body text, which would
// happily match the same word anywhere on the page. A bare label with no digits
// means zero — the count is dropped from the label at 0.
//
// `includes`, not `startsWith`: ActionButton renders its icon span first, so
// the textContent is "💦o-count 3" and a prefix match finds nothing.
//
// The label is "o-count". It was "Like" once and this selector was left behind
// — and a `find` that returns undefined is not an error here, so every T4 check
// quietly read `null` and failed (or, where a detail string dereferenced it,
// took the whole run down with it) until the label was rewritten. Match on a
// string the button actually renders.
const likeBtn = () => [...document.querySelectorAll('button')]
  .find(b => b.textContent.includes('o-count'));
// ActionButtons carry no aria-label; the stepper's two do.
const labelOf = (el) => {
  if (!el) return 'none';
  return (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 24);
};
const likes = () => {
  const b = likeBtn();
  if (!b) return null;
  const m = b.textContent.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
};

function press(el, key = 'Enter', keyCode = 13) {
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}

const keyEvent = (type) => new KeyboardEvent(type, {
  key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
});

/**
 * Press and *hold* Enter, then release it.
 *
 * The whole difference between a tap and a hold lives in the duration between
 * the two events — `useFocusable` starts a timer on keydown and only calls
 * `onLongPress` when it expires — so a check for the long-press path cannot be
 * faked with a bare keydown. The keyup matters as much as the wait: it is what
 * the hook uses to decide the hold is over, and what stops a stray keydown
 * looking like a still-running press on the next check.
 */
async function hold(el, ms = 900) {
  el.dispatchEvent(keyEvent('keydown'));
  await sleep(ms);
  el.dispatchEvent(keyEvent('keyup'));
}

/**
 * A short press: keydown, then keyup well inside the long-press window.
 *
 * `press()` above sends keydown alone, which is enough for every button that
 * does *not* opt into long-pressing — the hook calls `onEnter` straight from
 * keydown. The o-count button is the first one that opts in, and opting in
 * moves that button's short action to keyup so one press cannot both increment
 * and clear it. So a keydown-only "press" here is not a press at all: it starts
 * a timer, the harness moves on, and the count reads 0 forever — which is
 * exactly how the first run of these checks failed, with every read at 0 and an
 * empty server log rather than a wrong number.
 *
 * The keyup is load-bearing, not cosmetic: the hook only treats the release as
 * a completed tap if it saw the keydown.
 */
async function tap(el, ms = 60) {
  el.dispatchEvent(keyEvent('keydown'));
  await sleep(ms);
  el.dispatchEvent(keyEvent('keyup'));
}

async function setServerMode(mode) {
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneUpdate: mode }),
  });
}

/**
 * Patch any server behaviour, not just sceneUpdate.
 *
 * `oSeed` is a *setup* call on the server as well as a mode: it sets the
 * o-counter's starting value and clears its call log, so the presses that follow
 * are the only ones a check will read.
 */
async function setServer(patch) {
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function oCalls() {
  const r = await fetch('/ocalls');
  return r.json();
}

async function playAdds() {
  const r = await fetch('/playadds');
  return r.json();
}

async function resetCalls() {
  const r = await fetch('/resetcalls');
  return r.json();
}

// The hero's resume bar is a div carrying an inline width. Nothing else on
// the page has an inline size, so this finds it without depending on a CSS
// module's hashed class name.
const resumeBar = () => [...document.querySelectorAll('[role="dialog"] div[style]')]
  .find(el => (el.getAttribute('style') || '').includes('width:')) || null;

// The stats line's first figure. `plays?` and not `play`: the button says
// "Mark played", and the notice says "Marked played (…)"; only the stat line
// reads "N plays".
const playsShown = () => {
  const m = document.body.textContent.match(/(\d+) plays?\b/);
  return m ? Number(m[1]) : null;
};

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });
  await sleep(500);   // let autoFocus's 50ms timer land and the fetch resolve

  // ── T0: it renders, as a dialog ─────────────────────────
  check('T0 overlay renders with role=dialog', !!overlay());
  check('T0 title is shown',
    document.body.textContent.includes('VERIFY — detail page harness'));
  check('T0 Play holds focus on open',
    (document.activeElement?.textContent || '').includes('Play'),
    `activeElement="${(document.activeElement?.textContent || '').slice(0, 24)}"`);

  // ── T1: the detail fetch replaced the card's guess ──────
  // The card said 5.0. The fake server says 70. A page still showing the
  // card-derived value would read 5 here.
  check('T1 server rating replaced the card-derived one',
    ratingStars() === 7, `stepper reads ${ratingStars()} (card said 5, server says 70)`);
  check('T1 a detail-only field rendered',
    document.body.textContent.includes('2 plays'), 'stats line comes from the detail query');
  check('T1 the bitrate is read from the normalized key, in kb/s',
    document.body.textContent.includes('h264 / aac · 4200 kb/s'),
    `tech line: ${(document.body.textContent.match(/h264[^\n]{0,32}/) || ['<none>'])[0]}`);
  check('T1 actions are enabled in Live mode',
    byLabel('Increase rating') && !byLabel('Increase rating').disabled);

  // ── T13: marker row ─────────────────────────────────────
  //
  // The fixture's markers arrive out of order (1905, 125, 640) and carry
  // different titles and tags. Asserting the whole aria-label list makes the
  // ordering, the timestamp formatting (padMinutes, so 125 reads 02:05) and
  // the label source visible in one deterministic string.
  const markerGroup = document.querySelector('[role="group"][aria-label="Markers"]');
  const markerChips = markerGroup ? [...markerGroup.querySelectorAll('button')] : [];
  const markerLabels = markerChips.map(c => c.getAttribute('aria-label'));
  check('T13 markers render in timestamp order with formatted times',
    markerLabels.join('|')
      === 'Play from 02:05 — VERIFY marker one|Play from 10:40 — VERIFY marker two|Play from 31:45 — VERIFY marker three',
    markerLabels.join(' | '));
  check('T13 each chip shows its primary tag',
    markerChips.length === 3
      && markerChips[0].textContent.includes('VERIFY tag one')
      && markerChips[2].textContent.includes('VERIFY tag three'),
    markerChips.map(c => c.textContent.replace(/\s+/g, ' ')).join(' | '));
  check('T13 Play still owns focus with the marker row present',
    (document.activeElement?.textContent || '').includes('Play'),
    `activeElement="${(document.activeElement?.textContent || '').slice(0, 24)}"`);
  if (markerChips[1]) press(markerChips[1]);
  await sleep(80);
  check('T13 entering a marker hands its own timestamp to App',
    playedAt.length === 1 && playedAt[0] === 640,
    `onPlayAt calls: ${JSON.stringify(playedAt)}`);
  const detailQueries = await (await fetch('/detailfetches')).json();
  const detailQuery = (detailQueries[0] || '').replace(/\s+/g, ' ');
  check('T13 the marker selection stays narrow',
    detailQuery.includes('scene_markers { id seconds end_seconds title primary_tag { name } }'),
    'no screenshot/preview/stream in the scene_markers selection');

  // ── T2: optimistic update ───────────────────────────────
  // sceneUpdate is delayed 1200 ms server-side. Reading the new value well
  // before that reply arrives is the proof that the change is optimistic
  // rather than "await the server, then update".
  await setServerMode('slow');
  press(byLabel('Increase rating'));
  await sleep(60);
  check('T2 rating moved before the server replied (optimistic)',
    ratingStars() === 8, `at t≈60ms stepper reads ${ratingStars()}`);
  await sleep(1700);
  check('T2 rating holds the server value after the reply',
    ratingStars() === 8, `stepper reads ${ratingStars()}`);

  // ── T3: rollback on failure ─────────────────────────────
  await setServerMode('fail');
  press(byLabel('Increase rating'));
  await sleep(60);
  check('T3 optimistic value is visible before the failure lands',
    ratingStars() === 9, `at t≈60ms stepper reads ${ratingStars()}`);
  // Must outlast the server's 1200ms delay-then-fail. Reading at 900ms here
  // was reading before the failure had even been sent.
  await sleep(1700);
  check('T3 value rolled back after the failure',
    ratingStars() === 8, `stepper reads ${ratingStars()}`);
  check('T3 failure is reported in the aria-live status line',
    document.body.textContent.includes('not saved'));
  await setServerMode('ok');

  // ── T4: the o-count is a tally, not a toggle ────────────
  //
  // Two separate claims, and they need different evidence.
  //
  // "Each press adds one" is about what the *screen* does across presses:
  // 0 → 1 → 2, where a toggle would have gone 0 → 1 → 0. "It is an increment on
  // the server" is about which mutations were sent, and only the log can say —
  // a toggle and a tally draw the same screen from a press made at zero, and
  // diverge only on the second press.
  //
  // Seeding the server's tally to 5 while the page's own data says 0 keeps the
  // old check's property too: the first response (6) is a number no client-side
  // guess could produce, so the figure on screen is only explainable as the one
  // the response carried.
  await setServer({ oSeed: 5 });
  check('T4 the page opens on its own data, not the server\'s',
    likes() === 0, `reads ${likes()} (the detail fetch reports 0; the server's tally is 5)`);

  await tap(likeBtn());
  await sleep(500);
  check('T4 the count shown is the one the server answered with',
    likes() === 6, `reads ${likes()} — the client's own guess was 1, the server's tally is 6`);

  await tap(likeBtn());
  await sleep(500);
  check('T4 a second press adds one rather than taking it back',
    likes() === 7, `reads ${likes()} (a toggle would show 5 here)`);

  const pressed = await oCalls();
  check('T4 two presses sent two increments and no undo',
    pressed.filter(c => c.op === 'add').length === 2 &&
      pressed.filter(c => c.op === 'delete').length === 0,
    `${pressed.length} call(s): ${JSON.stringify(pressed.map(c => c.op))} — a toggle ` +
    'would have sent add then delete');

  // ── T4b: holding OK clears it ───────────────────────────
  //
  // A tally needs a way back to zero that is not "press it N times", and the
  // hold is the gesture the remote already has for that. It is also opt-in per
  // element, which is the reason the short action of *this* button fires on
  // keyup — see the ActionButton comment.
  await hold(likeBtn());
  await sleep(500);
  check('T4b holding OK clears the count to zero', likes() === 0, `reads ${likes()}`);

  const held = await oCalls();
  check('T4b ...with one reset, not one undo per like',
    held.at(-1)?.op === 'reset' && held.length === pressed.length + 1,
    `${JSON.stringify(held.map(c => c.op))} — one call clears any count`);
  check('T4b ...and a hold is not also a press',
    held.filter(c => c.op === 'add').length === 2,
    `${held.filter(c => c.op === 'add').length} add(s) — the release at the end of a hold ` +
    'must not fire the short action as well');
  check('T4b ...and reports what it did',
    /o-count cleared/i.test(document.body.textContent),
    'a destructive action that says nothing is indistinguishable from one that failed');

  await tap(likeBtn());
  await sleep(500);
  check('T4b the counter still works after a reset',
    likes() === 1, `reads ${likes()} (the server's tally was zeroed, so this is a fresh 1)`);

  // ── T4c: two presses answered out of order ──────────────
  //
  // The server increments in call order and answers each call with its own
  // total, but the first reply is held back so it lands *after* the second.
  // Without an attempt token the stale 1 is drawn over the fresh 2, and the
  // user's last press looks ignored. The same token is what stops a late
  // increment from bringing a count back after T4b's hold cleared it.
  await setServer({ oSeed: 0, sceneAddO: 'slow-first' });
  await tap(likeBtn());          // keeps the reply carrying 1 for ~1.2 s
  await sleep(150);
  await tap(likeBtn());          // answered at once, carrying 2
  await sleep(1800);             // ...then the stale reply arrives
  check('T4c the newest answer wins when two presses answer out of order',
    likes() === 2, `reads ${likes()} — the stale first reply carries 1`);
  const outOfOrder = await oCalls();
  check('T4c ...and both presses still reached the server',
    outOfOrder.filter(c => c.op === 'add').length === 2,
    JSON.stringify(outOfOrder.map(c => c.op)));
  await setServer({ sceneAddO: 'ok' });

  // ── T11: clear progress ─────────────────────────────────
  //
  // The card says resume 0; the detail fetch says 1800. So the bar appearing,
  // and the action being enabled, are both evidence that the fetched value is
  // what the page is operating on. The failure case runs first: it proves the
  // rollback without needing a second page instance to re-seed the resume
  // point.
  const clearBtn = () => byText('Clear progress', true);
  check('T11 the page offers Clear progress, enabled by the fetched resume point',
    !!clearBtn() && !clearBtn().disabled && !!resumeBar(),
    `button=${clearBtn()?.disabled === false ? 'enabled' : 'missing/disabled'}, bar=${!!resumeBar()}`);

  await setServer({ sceneResetActivity: 'fail' });
  press(clearBtn());
  await sleep(60);
  check('T11 clearing is optimistic: the bar goes before the server replies',
    !resumeBar(), `bar=${!!resumeBar()} at t≈60ms`);
  await sleep(1700);
  check('T11 ...and a refused reset puts the bar back',
    !!resumeBar(), `bar=${!!resumeBar()} after the failure`);
  check('T11 ...reports the failure', /Progress not cleared/.test(document.body.textContent),
    'a silent failure is indistinguishable from a press that never landed');
  check('T11 ...and does not tell App to prune anything',
    activityEvents.length === 0, `${activityEvents.length} event(s)`);

  await setServer({ sceneResetActivity: 'ok' });
  press(clearBtn());
  await sleep(60);
  check('T11 the retry clears optimistically too', !resumeBar(), `bar=${!!resumeBar()}`);
  await sleep(500);
  const resets = await resetCalls();
  // Two entries: the refused attempt is logged *before* the fake fails, the
  // same record-then-fail rule the save log uses, so a check can tell an
  // attempted-and-rejected write from one never sent. Both must ask for the
  // same thing.
  check('T11 resets ask for the resume point only',
    resets.length === 2 && resets.every(r => r.reset_resume === true
      && r.reset_duration === false),
    JSON.stringify(resets) + ' — reset_duration true would erase the watch time');
  check('T11 ...reports that it worked', /Progress cleared/.test(document.body.textContent),
    document.body.textContent.match(/Progress [a-z ]+/i)?.[0] || '(no notice)');
  check('T11 ...tells App the scene has left Continue Watching',
    activityEvents.length === 1 && activityEvents[0].id === '4242'
      && activityEvents[0].patch?.resumeTime === 0,
    JSON.stringify(activityEvents));
  check('T11 ...and the action disables once there is nothing to clear',
    clearBtn()?.disabled === true, `disabled=${clearBtn()?.disabled}`);

  // ── T12: mark played ────────────────────────────────────
  //
  // Same two claims as the o-count: the screen is optimistic (2 → 3 at 60 ms)
  // and the write is one `sceneAddPlay` with one explicit timestamp. The
  // server answers 7, a number the client's guess cannot produce, so "the
  // figure on screen came from the response" is observable.
  const markBtn = () => byText('Mark played', true);
  check('T12 the page offers Mark played, enabled in Live mode',
    !!markBtn() && !markBtn().disabled, `disabled=${markBtn()?.disabled}`);
  check('T12 setup: the stat line reads the fixture\'s 2 plays', playsShown() === 2,
    `reads ${playsShown()}`);

  await setServer({ sceneAddPlay: 'fail' });
  press(markBtn());
  await sleep(60);
  check('T12 marking is optimistic: 2 → 3 before the server replies',
    playsShown() === 3, `reads ${playsShown()} at t≈60ms`);
  await sleep(1700);
  check('T12 ...and a failed write rolls the count back', playsShown() === 2,
    `reads ${playsShown()} after the failure`);
  check('T12 ...and says so', /Not marked played/.test(document.body.textContent),
    document.body.textContent.match(/Not marked[^—]*/i)?.[0] || '(no notice)');

  // `slow`, not `ok`: an instant answer would land within the read below, so
  // the optimistic 3 would be indistinguishable from a page that just waited
  // for the server and drew 7.
  await setServer({ sceneAddPlay: 'slow' });
  const addsBefore = (await playAdds()).length;
  press(markBtn());
  await sleep(60);
  check('T12 the retry counts optimistically too', playsShown() === 3, `reads ${playsShown()}`);
  await sleep(1700);
  const adds = await playAdds();
  const lastAdd = adds.at(-1);
  check('T12 one play appended, with one explicit timestamp',
    adds.length === addsBefore + 1 && lastAdd?.id === '4242'
      && Array.isArray(lastAdd?.times) && lastAdd.times.length === 1
      && !Number.isNaN(Date.parse(lastAdd.times[0])),
    JSON.stringify(lastAdd));
  check('T12 the screen adopts the server\'s total, not its own guess',
    playsShown() === 7, `reads ${playsShown()} — the client guessed 3, the server answered 7`);
  check('T12 ...and reports the count', /Marked played \(7 plays\)/.test(document.body.textContent),
    document.body.textContent.match(/Marked played[^)]*\)/)?.[0] || '(no notice)');

  const play = byText('Play', false);

  // ── T8: the action row is traversable ───────────────────
  //
  // Reported from the TV: Play took focus and Enter worked, but no arrow key
  // moved off it. The cause was that the stepper's "−" was DOM-disabled while
  // a scene was unrated, and it sits immediately right of Play.
  //
  // The fix is the state the button is in, not a nav special case: at a bound
  // it stays native-enabled and carries `aria-disabled` plus the muted style,
  // so it can hold focus and its Enter handler simply does nothing. What is
  // asserted is the property that removed the wall: Right from Play lands on
  // the inert "−", and Right again leaves it.
  //
  // Drive the rating down to 0 first, because that is the state the TV was
  // in: with stars > 0 the "−" is editable and the bug hides.
  for (let i = 0; i < 9; i++) {
    const d = byLabel('Decrease rating');
    if (!d || d.getAttribute('aria-disabled') === 'true') break;
    press(d);
    await sleep(120);
  }
  check('T8 setup: the rating is 0 and "−" is focusable but inert',
    ratingStars() === 0
      && byLabel('Decrease rating')?.disabled === false
      && byLabel('Decrease rating')?.getAttribute('aria-disabled') === 'true',
    `stars=${ratingStars()}, dec.disabled=${byLabel('Decrease rating')?.disabled},`
      + ` aria-disabled=${byLabel('Decrease rating')?.getAttribute('aria-disabled')}`);

  play.focus();
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(140);
  check('T8 Right from Play reaches the inert "−" instead of stopping on Play',
    document.activeElement === byLabel('Decrease rating'),
    `landed on "${labelOf(document.activeElement)}"`);

  press(document.activeElement, 'ArrowRight', 39);
  await sleep(140);
  check('T8 ...and Right again leaves it for "+"',
    document.activeElement === byLabel('Increase rating'),
    `landed on "${labelOf(document.activeElement)}"`);

  // ── T10: the whole row is walkable, not just the first hop ─
  play.focus();
  const path = [];
  for (let i = 0; i < 6; i++) {
    press(document.activeElement, 'ArrowRight', 39);
    await sleep(140);   // clear the 90ms repeat throttle
    path.push(labelOf(document.activeElement));
  }
  check('T10 Right walks the action row through to Back',
    path.includes('Back'), `path: ${path.join(' → ')}`);

  // ── T13: a sideways press walks its own line first ──────
  // The action row wraps at this viewport: Play / "−" / "+" / Organised /
  // o-count on the first line, then the disabled Clear progress, Mark played
  // and Back on the second. The second line starts almost directly under the
  // rating's "+", so a nearest-centre score used to prefer it (dx 17, dy 52)
  // over "Organised" on the same line (dx 98) — Right skipped the rest of the
  // row, jumped down, and came back up at the end. What is asserted is the
  // order of the first four hops, not merely that Back is reachable (T10's
  // claim).
  //
  // "−" is in the line even though it is inert: the button is focusable by
  // design (see T8), and Clear progress is not, because it is native-disabled.
  play.focus();
  const rowPath = [];
  for (let i = 0; i < 7; i++) {
    press(document.activeElement, 'ArrowRight', 39);
    await sleep(140);   // clear the same throttle T10 waits out
    rowPath.push(labelOf(document.activeElement));
  }
  check('T13 Right finishes its own line before changing lines',
    rowPath.slice(0, 4).join(' → ')
      === 'Decrease rating → Increase rating → ✓Organised → 💦o-count 2',
    `path: ${rowPath.join(' → ')}`);

  // ── T15: the wrap is reversible ─────────────────────────
  // Reading order in reverse: Left out of the second line enters the first
  // line at its *right* edge. A nearest-centre score would instead climb to
  // whichever control happens to be left of the current one.
  const backPath = [];
  for (let i = 0; i < 3; i++) {
    press(document.activeElement, 'ArrowLeft', 37);
    await sleep(140);
    backPath.push(labelOf(document.activeElement));
  }
  check('T15 Left walks the wrapped row back in reverse reading order',
    backPath.join(' → ') === 'Mark played → 💦o-count 2 → ✓Organised',
    `path: ${backPath.join(' → ')}`);

  // ── T9: control for T8 ──────────────────────────────────
  // Same DOM, same registry, one attribute added: the native `disabled` the
  // app used to put on "−" at zero stars. The candidate search skips a
  // native-disabled control, so Right now lands on "+". That is the exact
  // behaviour T8 asserts away, and it makes the two attributes the only
  // difference — T8's landing on "−" is `aria-disabled` doing its job, not a
  // layout accident.
  byLabel('Decrease rating').setAttribute('disabled', '');
  play.focus();
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(140);
  check('T9 CONTROL: a native-disabled "−" is skipped; aria-disabled is what makes it reachable',
    document.activeElement === byLabel('Increase rating'),
    `landed on "${labelOf(document.activeElement)}"`);
  // Leave the DOM as found: React still believes this button is enabled, and
  // a later re-render would restore it — but the trap tests below should not
  // run against a state the app never produces.
  byLabel('Decrease rating').removeAttribute('disabled');

  // ── T5: focus trap, with a control ──────────────────────
  const up = async (n) => {
    for (let i = 0; i < n; i++) {
      press(document.activeElement, 'ArrowUp', 38);
      await sleep(140);   // clear useKeyHandler's 90ms repeat throttle
    }
  };

  play.focus();
  await up(3);
  check('T5 Up does not escape the overlay (trap active)',
    !!overlay() && overlay().contains(document.activeElement),
    `activeElement="${document.activeElement?.id || (document.activeElement?.textContent || '').slice(0, 20)}"`);

  // Control: strip the attribute that creates the trap and repeat the exact
  // same input. If focus now escapes, the trap is what was holding it —
  // same DOM, same registry, one attribute different.
  const ov = overlay();
  ov.removeAttribute('role');
  play.focus();
  await up(3);
  const escaped = !overlay()?.contains(document.activeElement);
  check('T5 CONTROL: without role=dialog the same keypress DOES escape',
    escaped,
    `activeElement="${document.activeElement?.id || (document.activeElement?.textContent || '').slice(0, 20)}"`);
  // `ov`, not `overlay()` — with the role removed the query returns null.
  ov.setAttribute('role', 'dialog');

  // ── T6: Play fires onPlay ───────────────────────────────
  play.focus();
  press(play);
  await sleep(80);
  check('T6 Play button calls onPlay', playedCount === 1, `fired ${playedCount}×`);

  // ── T6b: Play carries the fetched resume point ─────────
  // The card says 0; FindSceneDetail says 1800. App builds the player's queue
  // from the scene object this page hands it, and the player decides whether
  // to ask "resume or start over" from that item. A listing that stays mounted
  // after playback is not refetched, so its card is stale; without this value
  // the scene replays without asking. A fresh mount because T11 above cleared
  // this page's resume point.
  let playSeed = null;
  const seedHost = document.createElement('div');
  document.body.appendChild(seedHost);
  const seedRoot = createRoot(seedHost);
  seedRoot.render(
    <SceneDetailPage
      key="play-seed"
      scene={{ ...SCENE, id: '4245' }}
      onClose={() => {}}
      onPlay={(resumeTime) => { playSeed = resumeTime; }}
      onPlayAt={() => {}}
    />,
  );
  await sleep(900);
  const seedPlay = [...seedHost.querySelectorAll('button')]
    .find(b => b.textContent.includes('Play'));
  if (seedPlay) press(seedPlay);
  await sleep(80);
  check('T6b Play forwards the fetched resume point, not the stale card value',
    playSeed === 1800, `onPlay received ${playSeed}`);
  seedRoot.unmount();
  seedHost.remove();

  // ── T7: Back closes, and does not reach App ─────────────
  // The page's handler is capture-phase on window and stops propagation, so
  // useKeyHandler's bubble-phase window listener must never see this.
  window.__backSeen = 0;
  const before = closedCount;
  press(byText('Back', true), 'Backspace', 10009);
  await sleep(250);
  check('T7 Tizen Back (10009) closes the page', closedCount === before + 1);
  check('T7 Back did NOT reach the App-level handler',
    window.__backSeen === 0, `App onBack fired ${window.__backSeen}×`);
  check('T7 overlay is gone after close', !overlay());

  // ── T13b: a scene with no markers draws no row ──────────
  // A second mount, because the mode is read by the detail fetch, and the
  // first page fetched its markers before this mode existed.
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneMarkers: 'empty' }),
  });
  const emptyHost = document.createElement('div');
  document.body.appendChild(emptyHost);
  const emptyRoot = createRoot(emptyHost);
  emptyRoot.render(
    <SceneDetailPage
      key="empty-markers"
      scene={{ ...SCENE, id: '4243' }}
      onClose={() => {}}
      onPlay={() => {}}
      onPlayAt={() => {}}
    />,
  );
  await sleep(900);
  check('T13 a scene without markers renders no marker row',
    !emptyHost.querySelector('[role="group"][aria-label="Markers"]'),
    'no group for an empty scene_markers array');
  emptyRoot.unmount();
  emptyHost.remove();

  // ── T14: duration rounding at the minute boundary ───────
  // A third mount, because the duration comes from the detail fetch. 3599.6 s
  // is one second short of an hour and rounds to 3600: the formatter must
  // carry that into the hour rather than print "59m 60s".
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneFile: 'rounding' }),
  });
  const roundingHost = document.createElement('div');
  document.body.appendChild(roundingHost);
  const roundingRoot = createRoot(roundingHost);
  roundingRoot.render(
    <SceneDetailPage
      key="rounding"
      scene={{ ...SCENE, id: '4244' }}
      onClose={() => {}}
      onPlay={() => {}}
      onPlayAt={() => {}}
    />,
  );
  await sleep(900);
  const roundingText = roundingHost.textContent || '';
  check('T14 a 3599.6 s file reads 1h 0m, not 59m 60s',
    roundingText.includes('1h 0m') && !roundingText.includes('59m 60s'),
    `durations: ${(roundingText.match(/\d+h \d+m|\d+m \d+s|\d+s/g) || ['<none>']).join(', ')}`);
  roundingRoot.unmount();
  roundingHost.remove();
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneFile: 'ok' }),
  });

  // ── T13c: Test mode has its own markers ─────────────────
  // `mockDetail` answers per-open with no server row, so the row must come
  // from the mock rather than from the fetch that Test mode skips.
  await fetch('/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneMarkers: 'ok' }),
  });
  setSettings({ useMock: true });
  const mockHost = document.createElement('div');
  document.body.appendChild(mockHost);
  const mockRoot = createRoot(mockHost);
  mockRoot.render(
    <SceneDetailPage
      key="mock-markers"
      scene={{ ...SCENE, id: 'vid-9001', tags: ['VERIFY tag A', 'VERIFY tag B'] }}
      onClose={() => {}}
      onPlay={() => {}}
      onPlayAt={() => {}}
    />,
  );
  await sleep(900);
  const mockLabels = [...mockHost.querySelectorAll('[role="group"][aria-label="Markers"] button')]
    .map(c => c.getAttribute('aria-label'));
  check('T13 Test mode renders its two mock markers',
    mockLabels.join('|')
      === 'Play from 02:00 — VERIFY tag A|Play from 10:00 — VERIFY tag B',
    mockLabels.join(' | '));
  mockRoot.unmount();
  mockHost.remove();
  setSettings({ useMock: false });

  await finish();
}

createRoot(document.getElementById('root')).render(<Harness />);
run().catch(async (e) => {
  results.push({
    name: 'HARNESS CRASHED',
    pass: false,
    detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
  });
  try { await finish(); } catch { /* nothing left to do */ }
});
