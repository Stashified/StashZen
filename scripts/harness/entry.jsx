/**
 * Headless verification driver for SceneDetailPage.
 *
 * Mounts the real component and hooks against a fake GraphQL endpoint, so only
 * the server is a stand-in. The page runs the assertions and POSTs results.
 */

import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import SceneDetailPage from '../../src/pages/SceneDetailPage.jsx';
import { useKeyHandler } from '../../src/hooks/useKeyHandler.js';
import { useFocusable, registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms = 4000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

// The card Enter was pressed on. Its rating is the display string the grid
// would carry (5), while the server answers 7, which makes T1 real.
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
// Every `onPlayAt` timestamp, in order: a marker press must deliver its own
// timestamp, not just "the player opened".
const playedAt = [];
// Every `onActivityChange`. The resume reset is the only one App acts on, so
// this is where "the page told Home to prune the card" is observable.
const activityEvents = [];
// Every gallery handed to App through the chip row: the chip must pass the
// gallery row, not a scene or timestamp; the tab change is App's business.
const gallerySelections = [];
// Entity chips and related cards: the page only reports the press, the tab
// change is App's business (see the sceneDetail group in AppOverlays).
const tagSelections = [];
const studioSelections = [];
const performerSelections = [];
const relatedSelections = [];

/**
 * Focusables outside the overlay, in the same spatial-nav registry, so "focus
 * never lands on them" shows a trap rather than nothing to find. Normal flow,
 * not `position: fixed`: `findBestCandidate` skips a null `offsetParent`.
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
          onGallerySelect={(gallery) => gallerySelections.push(gallery)}
          onTagSelect={(tag) => tagSelections.push(tag)}
          onStudioSelect={(studio) => studioSelections.push(studio)}
          onPerformerSelect={(performer) => performerSelections.push(performer)}
          onRelatedSceneSelect={(scene) => relatedSelections.push(scene)}
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
// Read the count off the button, not body text which may match elsewhere; a
// bare label means zero. `includes`, not `startsWith`: the icon span comes
// first ("💦o-count 3"). A stale label selector silently reads null.
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
 * Press and hold Enter, then release. A tap and a hold differ only in the
 * duration: `useFocusable` arms a timer on keydown and `onLongPress` fires when
 * it expires, so the long-press path cannot be faked with a bare keydown.
 */
async function hold(el, ms = 900) {
  el.dispatchEvent(keyEvent('keydown'));
  await sleep(ms);
  el.dispatchEvent(keyEvent('keyup'));
}

/**
 * A short press: keydown, then keyup inside the long-press window. The
 * o-count button opts into long-pressing, so its short action fires on keyup;
 * a keydown-only "press" just arms a timer and reads 0 forever.
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
 * Patch any server behaviour. `oSeed` is also setup: it sets the o-counter's
 * starting value and clears its call log, so later presses are the only ones
 * a check reads.
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

// The hero's resume bar is a div carrying an inline width; nothing else on
// the page has one, so this avoids a hashed CSS-module class name.
const resumeBar = () => [...document.querySelectorAll('[role="dialog"] div[style]')]
  .find(el => (el.getAttribute('style') || '').includes('width:')) || null;

// The stats line's first figure. `plays?` and not `play`: the button says
// "Mark played" and the notice "Marked played (…)"; only the stat reads "N plays".
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
  // The card said 5.0; the fake server says 70. A page still showing the
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
  // Fixture markers arrive out of order (1905, 125, 640); asserting the whole
  // aria-label list shows ordering, `padMinutes` (125 → 02:05) and label source.
  const markerGroup = document.querySelector('[role="group"][aria-label="Markers"]');
  const markerChips = markerGroup ? [...markerGroup.querySelectorAll('button')] : [];
  const markerLabels = markerChips.map(c => c.getAttribute('aria-label'));
  check('T13 markers render in timestamp order with formatted times',
    markerLabels.join('|')
      === 'Play from 02:05: VERIFY marker one|Play from 10:40: VERIFY marker two|Play from 31:45: VERIFY marker three',
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

  // ── T16: the gallery hand-off ───────────────────────────
  // Galleries arrive with the detail query (two, ids distinct from the Galleries
  // tab); Enter is a tab change in App, so no onClose and no timestamp.
  const galleryGroup = document.querySelector('[role="group"][aria-label="Galleries"]');
  const galleryChips = galleryGroup ? [...galleryGroup.querySelectorAll('button')] : [];
  check('T16 each gallery in the scene draws one focusable chip',
    galleryChips.map(c => c.getAttribute('aria-label')).join('|')
      === 'Browse gallery: VERIFY gallery one|Browse gallery: VERIFY gallery two',
    galleryChips.map(c => c.getAttribute('aria-label')).join(' | ') || 'no gallery row');
  check('T16 the scene query asks for galleries as id and title only',
    detailQuery.includes('galleries { id title }'),
    detailQuery.slice(detailQuery.indexOf('galleries'), detailQuery.indexOf('galleries') + 40));
  check('T16 the chips are registered stops in the scene-detail zone',
    [...registry.keys()].filter(id => id.startsWith('scene-gallery-')).join(',')
      === 'scene-gallery-7001,scene-gallery-7002',
    [...registry.keys()].filter(id => id.startsWith('scene-gallery-')).join(','));
  const playedBeforeGallery = playedAt.length;
  if (galleryChips[1]) press(galleryChips[1]);
  await sleep(120);
  check('T16 Enter hands that gallery to App — not a timestamp, and not a close',
    gallerySelections.length === 1
      && gallerySelections[0].id === '7002'
      && gallerySelections[0].title === 'VERIFY gallery two'
      && playedAt.length === playedBeforeGallery
      && closedCount === 0,
    `selected=${JSON.stringify(gallerySelections)} `
    + `playAt=${playedAt.length - playedBeforeGallery} closes=${closedCount}`);

  // ── T17: performer, studio and tag chips are focus stops ─
  // Each chip is a button registered in the page's own zone, and Enter hands
  // the row to App rather than closing the page (the tab change does that).
  const chipIds = [...registry.keys()].filter(id => /^scene-(tag|performer|studio)-/.test(id));
  check('T17 every performer, studio and tag chip is a focus stop',
    chipIds.includes('scene-studio-1')
      && chipIds.includes('scene-performer-1')
      && chipIds.includes('scene-tag-3'),
    chipIds.join(','));

  const closesBeforeChips = closedCount;
  const pressChip = async (id) => {
    const el = registry.get(id)?.el;
    if (!el) return;
    el.focus();
    press(el);
    await sleep(80);
  };
  await pressChip('scene-studio-1');
  await pressChip('scene-performer-1');
  await pressChip('scene-tag-3');
  check('T17 Enter on a chip hands that entity to App',
    studioSelections.map(x => x.id).join(',') === '1'
      && performerSelections.map(x => x.id).join(',') === '1'
      && tagSelections.map(x => x.id).join(',') === '3',
    `studio=${JSON.stringify(studioSelections.map(x => x.id))} `
    + `performer=${JSON.stringify(performerSelections.map(x => x.id))} `
    + `tag=${JSON.stringify(tagSelections.map(x => x.id))}`);
  check('T17 a chip does not close the page itself', closedCount === closesBeforeChips);

  // ── T18: "More from" rows ───────────────────────────────
  // The fixture carries a studio and one performer, so both rows ask for the
  // listing and the fake server answers four rows including the open 4242.
  const relatedReady = await waitFor(() => registry.has('related-studio-7'), 4000);
  const relatedLabels = [...document.querySelectorAll('[aria-label^="More from "]')]
    .map(el => el.getAttribute('aria-label'));
  check('T18 a studio row and a performer row are drawn',
    relatedReady
      && relatedLabels.join('|') === 'More from Harness Studio|More from Performer One',
    relatedLabels.join(' | ') || 'no related rows');

  const relatedIds = [...registry.keys()].filter(id => id.startsWith('related-'));
  check('T18 the open scene is excluded and the row stops at four',
    relatedIds.filter(id => id.startsWith('related-studio-')).length === 3
      && !relatedIds.some(id => id.endsWith('-4242')),
    relatedIds.join(','));

  const sceneRequests = await (await fetch('/requests')).json();
  const relatedReqs = sceneRequests.filter(r => r.per_page === 5);
  check('T18 the rows are fetched with the entity criteria',
    relatedReqs.some(r => JSON.stringify(r.scene_filter?.studios?.value) === '["1"]')
      && relatedReqs.some(r => JSON.stringify(r.scene_filter?.performers?.value) === '["1"]'),
    JSON.stringify(relatedReqs.map(r => r.scene_filter)));

  if (relatedIds.includes('related-studio-8')) {
    const card = registry.get('related-studio-8').el;
    card.focus();
    press(card);
    await sleep(80);
  }
  check('T18 Enter on a related card hands that scene to App',
    relatedSelections.length === 1 && relatedSelections[0].id === '8',
    JSON.stringify(relatedSelections.map(x => x.id)));

  // ── T19: the details column insets its rows ─────────────
  // A scroll container clips at its padding box, box-shadow and transforms
  // included. A chip or button paints its focus ring 5px outside the box and
  // a focused card scales 1.05 past it, so the first item of every row is cut
  // while the column insets on the right but not the left. The column must
  // also not overflow sideways: with overflow-x unset it computes to auto
  // next to overflow-y: auto, so a tag chip wider than the column can slide
  // every row left and cut borders.
  //
  // Measured as the padding, not the ring: this driver does not load
  // index.css, so the ring's `var()` computes to `none` here. The 5px is that
  // file's outer spread.
  let column = null;
  for (let n = registry.get('related-studio-8')?.el; n; n = n.parentElement) {
    if (getComputedStyle(n).overflowY === 'auto') { column = n; break; }
  }
  const RING = 5;
  const outside = [];
  const sideways = [];
  let focused = 0;
  const focusIn = async (el) => {
    if (!el) return;
    focused++;
    el.focus();
    await sleep(80);
    const left = el.getBoundingClientRect().left
      - column.getBoundingClientRect().left - column.clientLeft;
    if (left < 0) outside.push(`${labelOf(el)}@${Math.round(left)}`);
    if (column.scrollLeft !== 0) sideways.push(`${labelOf(el)}@${column.scrollLeft}`);
    column.scrollLeft = 0;
  };
  for (const id of [...registry.keys()].filter(x => x.startsWith('related-'))) {
    await focusIn(registry.get(id)?.el);
  }
  for (const id of [...registry.keys()].filter(x => /^scene-(tag|performer|studio)-/.test(x))) {
    await focusIn(registry.get(id)?.el);
  }
  for (const id of [...registry.keys()]
    .filter(x => /^scene-(play|organized|like|clear-progress|mark-played|back)$/.test(x))) {
    await focusIn(registry.get(id)?.el);
  }
  const padLeft = column ? parseFloat(getComputedStyle(column).paddingLeft) : 0;
  check('T19 the details column insets its rows so no item meets the clip edge',
    column !== null && padLeft >= RING && outside.length === 0
      && sideways.length === 0 && column.scrollWidth <= column.clientWidth,
    `${focused} focuses | padding-left ${padLeft} `
    + `| outside the edge: ${outside.join(' ') || 'none'} `
    + `| sideways: ${sideways.join(' ') || 'none'} `
    + `| width ${column?.scrollWidth}/${column?.clientWidth}`);

  // ── T2: optimistic update ───────────────────────────────
  // sceneUpdate is delayed 1200 ms; the new value before the reply proves the
  // change is optimistic rather than await-then-update.
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
  // Must outlast the server's 1200 ms delay-then-fail; reading at 900 ms was
  // reading before the failure was even sent.
  await sleep(1700);
  check('T3 value rolled back after the failure',
    ratingStars() === 8, `stepper reads ${ratingStars()}`);
  check('T3 failure is reported in the aria-live status line',
    document.body.textContent.includes('not saved'));
  await setServerMode('ok');

  // ── T4: the o-count is a tally, not a toggle ────────────
  // Screen across presses (0 → 1 → 2; a toggle returns to 0) and the mutation
  // log (add vs delete). Seeding 5 makes the first answer (6) no client guess.
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
  // A tally needs a way back to zero; hold is opt-in per element, so this
  // button's short action fires on keyup (see the ActionButton comment).
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
  // The first reply is held back to land after the second; without an attempt
  // token the stale 1 overwrites 2, and it also blocks reviving a cleared count.
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
  // The card says resume 0, the detail fetch 1800; the bar and enabled action
  // prove the fetched value. Failure runs first to prove rollback.
  const clearBtn = () => byText('Clear progress', true);
  // Offered means muted-or-not: the button is never natively disabled once it
  // exists, it carries `aria-disabled` instead, see T11's focus check below.
  const clearOffered = () => !!clearBtn() && !clearBtn().disabled
    && clearBtn().getAttribute('aria-disabled') !== 'true';
  check('T11 the page offers Clear progress, enabled by the fetched resume point',
    clearOffered() && !!resumeBar(),
    `button=${clearOffered() ? 'enabled' : 'missing/muted'}, bar=${!!resumeBar()}`);

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
  // Focused first, the way the remote reaches it. The press itself mutes the
  // button; the cursor must stay on it.
  clearBtn().focus();
  await sleep(60);
  press(clearBtn());
  await sleep(60);
  check('T11 the retry clears optimistically too', !resumeBar(), `bar=${!!resumeBar()}`);
  await sleep(500);
  const resets = await resetCalls();
  // Two entries: the refused attempt is logged before the fake fails, the
  // same record-then-fail rule as the save log, so an attempted-and-rejected
  // write is distinguishable from one never sent.
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
  check('T11 ...and the action mutes once there is nothing to clear',
    clearBtn()?.disabled === false
      && clearBtn()?.getAttribute('aria-disabled') === 'true',
    `disabled=${clearBtn()?.disabled}, aria-disabled=${clearBtn()?.getAttribute('aria-disabled')}`);
  check('T11 ...with the cursor still on it rather than on <body>',
    document.activeElement === clearBtn(),
    `activeElement=${document.activeElement?.tagName || 'none'}`);

  // ── T12: mark played ────────────────────────────────────
  // Optimistic (2 → 3 at 60 ms) and one `sceneAddPlay` with one explicit
  // timestamp; the server answers 7, which no client guess produces.
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
  // the optimistic 3 would be indistinguishable from a page that waited and
  // drew 7.
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
  // At zero stars "−" was DOM-disabled and trapped focus on Play; it is now
  // native-enabled with `aria-disabled` and an inert Enter, driven to 0 here.
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
  // Seven controls to cross: the muted Clear progress stays in the walk, as the
  // inert "−" at zero stars does (T8).
  play.focus();
  const path = [];
  for (let i = 0; i < 7; i++) {
    press(document.activeElement, 'ArrowRight', 39);
    await sleep(140);   // clear the 90ms repeat throttle
    path.push(labelOf(document.activeElement));
  }
  check('T10 Right walks the action row through to Back',
    path.includes('Back'), `path: ${path.join(' → ')}`);

  // ── T13: a sideways press walks its own line first ──────
  // The row wraps; a nearest-centre score jumped to the second line (dx 17,
  // dy 52) instead of "Organised" on the same line (dx 98). First four hops.
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
  // Left out of line two enters line one at its right edge; a nearest-centre
  // score would instead climb to whatever sits left of the current control.
  // Clear progress is muted here, T11 cleared it, and stays in the walk.
  const backPath = [];
  for (let i = 0; i < 3; i++) {
    press(document.activeElement, 'ArrowLeft', 37);
    await sleep(140);
    backPath.push(labelOf(document.activeElement));
  }
  check('T15 Left walks the wrapped row back in reverse reading order',
    backPath.join(' → ') === 'Mark played → Clear progress → 💦o-count 2',
    `path: ${backPath.join(' → ')}`);

  // ── T9: control for T8 ──────────────────────────────────
  // Same DOM and registry plus the native `disabled` the app used to set at
  // zero stars: a native-disabled control is skipped, so Right lands on "+".
  byLabel('Decrease rating').setAttribute('disabled', '');
  play.focus();
  press(document.activeElement, 'ArrowRight', 39);
  await sleep(140);
  check('T9 CONTROL: a native-disabled "−" is skipped; aria-disabled is what makes it reachable',
    document.activeElement === byLabel('Increase rating'),
    `landed on "${labelOf(document.activeElement)}"`);
  // Leave the DOM as found: React still believes this button is enabled, but
  // the trap tests below should not run against a state the app never produces.
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

  // Control: strip the attribute that creates the trap and repeat the same
  // input. If focus escapes, the trap was holding it, same DOM, one attribute
  // different.
  const ov = overlay();
  ov.removeAttribute('role');
  play.focus();
  await up(3);
  const escaped = !overlay()?.contains(document.activeElement);
  check('T5 CONTROL: without role=dialog the same keypress DOES escape',
    escaped,
    `activeElement="${document.activeElement?.id || (document.activeElement?.textContent || '').slice(0, 20)}"`);
  // `ov`, not `overlay()`, with the role removed the query returns null.
  ov.setAttribute('role', 'dialog');

  // ── T6: Play fires onPlay ───────────────────────────────
  play.focus();
  press(play);
  await sleep(80);
  check('T6 Play button calls onPlay', playedCount === 1, `fired ${playedCount}×`);

  // ── T6b: Play carries the fetched resume point ─────────
  // The card says 0, the detail fetch 1800; a stale mounted listing would
  // replay without prompting. Fresh mount: T11 cleared this page's resume.
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
  // A second mount, because the mode is read by the detail fetch and the
  // first page already fetched its markers.
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
  // A third mount: duration comes from the detail fetch. 3599.6 s rounds to
  // 3600; the formatter must carry into the hour, not print "59m 60s".
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
  // from the mock, not from the fetch Test mode skips.
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
      === 'Play from 02:00: VERIFY tag A|Play from 10:00: VERIFY tag B',
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
