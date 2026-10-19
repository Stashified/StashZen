/**
 * Headless driver for the four browse-only sections (0.11.0's P4).
 *
 * Mounts the whole `App`, like rail-entry, because almost everything here is a
 * property of two components together rather than of either alone: the grid
 * and the service it calls, the card and the tab it lives on, the activation
 * and the tab it switches to.
 *
 * ## What is worth asserting here, and what is not
 *
 * The four sections are, by design, four instances of one thing — so the
 * *shape* checks (a grid rendered, 40 cards, a count line) are near-duplicates
 * of each other and the paging behaviour is already covered seven ways by
 * list-entry. Repeating that here would inflate the tally without adding a
 * claim. What this file covers is the four places where the sections differ
 * from the three that came before, because those are the new code:
 *
 *   S1–S3  the four sections render, and each sends *its own* operation with
 *          *its own* filter variable. The fake's REQUEST log records which —
 *          and it is the one thing a shared service factory can get wrong for
 *          exactly one section without anything failing to render.
 *
 *   S4     the four sort menus carry values Stash actually accepts. This is
 *          the check that would have caught the guesses: Tags take
 *          `scenes_count` (plural), Studios take `tag_count` (singular),
 *          Images take `performer_count` and reject `performers_count`. The
 *          fake does not validate sorts, so this asserts the *request* rather
 *          than the reply — see the note on S4.
 *
 *   S4b    arriving at a section adopts its declared default sort **and
 *          direction**. Tags declare `name` + `asc`, and until 0.18.0 a
 *          valid-but-foreign sort carried in from the previous tab survived
 *          the switch, so the default was applied only to users who had never
 *          touched a sort; the direction was not adopted at all until 0.18.1
 *          (the TV pass: "tags sort should be ascending"), so Tags opened
 *          Z→A. S4b2 pins the other half: the asc must not leak onto a
 *          date-sorted tab on the way back out.
 *
 *   S4c    the same claim for the two tabs the first pass missed: Performers
 *          declare `name` + `asc` and Markers `title` + `asc` (the 0.18.4 TV
 *          report: "these should have default sort as title ascending:
 *          Markers, Performers"). Each is left on Date Added + DESC, sent
 *          away, and required back on its declared pair.
 *
 *   S4d    arriving at Markers costs *one* page-1 request, carrying Markers'
 *          own Title/ASC — not two, the first of which is the previous tab's
 *          sort and is discarded. This is the "sluggish Markers tab" report
 *          from 2026-10-17: the arrival rule was an effect, so the grid
 *          fetched before it ran. The check reads the request log, because
 *          both replies render and the screen cannot tell one from two.
 *
 *   S5–S8  activation. A tag is not a page: it is a filter on the scene
 *          listing, arriving via a tab switch, which is the one piece of
 *          genuinely new control flow in this phase. The two halves that can
 *          break independently are checked separately — that arrival *keeps*
 *          the filter (the tab-change effect used to clear it in the act of
 *          applying it) and that Back *returns* to the right card.
 *
 *   S6a    a gallery card's second line: studio when there is one, folder
 *          otherwise. Both are on the fake, on neighbouring rows, so the
 *          fallback order is decidable rather than assumed.
 *
 *   S9–S11 the image viewer. New overlay, new key handling, and one claim that
 *          no other overlay makes: it shows `paths.image` rather than the
 *          thumbnail the card was showing.
 *
 *   S10b–S11d the viewer's info panel (0.29.0). Up reaches it, one request
 *          per image opened, reopen and stepping back are cache hits, the
 *          stale-answer race is sampled while the live answer is still in
 *          flight, Back peels the panel before the viewer, and a failure is
 *          reported and not cached. The panel adds no focus stops, and the
 *          fake names the studio after the requested id so a stale answer
 *          cannot pass for the right one. Since 0.29.1, Left/Right also step
 *          while the Info button holds focus (they used to require a Down
 *          first); both checks compare the title before and after the press,
 *          because a no-op left the expected title already on screen.
 *
 * ## The control experiments, and what they actually measured
 *
 * The project's rule is that a green run proves nothing until the line it
 * covers has been watched going red. Three were run for this file, and one of
 * them falsified the claim it was testing — which is why the results below are
 * written as measurements rather than as intentions.
 *
 *   - **Removing `key={activeTab}` from the `EntityPage` branch** — the fix for
 *     the bug this file found on 2026-10-16 — turns the four S1 prefix checks'
 *     *content* assertions red, S2 red for three of four operations, and S3
 *     red. The card-count halves of S1 stay green: the tiles are keyed by the
 *     descriptor's prefix, so they read `studio-1`..`studio-40` whatever rows
 *     are underneath them, and every fixture row is `id: "1"`, `id: "2"`, … .
 *     That asymmetry is the whole reason S1 asserts text and not a count.
 *   - **Deleting `workingFilterFor` from the activation** (so the tab-change
 *     effect cannot tell arrival from departure) turns three checks red: S5's
 *     listing check, S5's dropdown label and S6's listing check. That is the
 *     bug this phase's one non-obvious design decision exists to prevent — but
 *     it is **not** what the first draft of this file measured, and the
 *     difference is the most useful thing in this header. As written then, the
 *     same deletion turned exactly one check red. The reason: the filter and
 *     the tab are set in one batch, so the filtered request is *always* sent,
 *     and the unfiltered refetch that follows is page 1 of a listing
 *     `listCache` already holds from mount — so no second request reaches the
 *     log, and a "was a filtered request sent" assertion passes either way.
 *     The listing checks now read the *screen* (`liveCards`) rather than the
 *     log, which is what makes them able to fail; that in turn required the
 *     fake to honour the `tags` and `galleries` criteria — see server.py.
 *     S7 stays green under this deletion, and should: it is about where Back
 *     goes, not about what Home is showing.
 *   - **Deleting the `filterOrigin` branch in `onBack`** turns S7 red — all
 *     three of its checks, since Back falls through to the exit prompt and so
 *     "returns to Tags", "no dialog" and "focus is back on the tag" all fail —
 *     and both of S8's, because S8 drives the same Back path from the same
 *     filtered Home. Five red, 41/46. (The first draft's header guessed S8
 *     alone; the measurement is the whole S7 block plus the whole S8 pair.)
 *
 * The rest is a straight "did the request carry it" assertion on a log the fake
 * writes before dispatch, and the log itself is proven live by S3 failing when
 * a service is pointed at the wrong operation.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry, getCurrentFocusId } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});
const errorTail = () => (errors.length ? errors.slice(-2).join(' | ') : 'none');

async function waitFor(pred, ms = 8000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

async function press(key) {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await sleep(150);
}

// Enter fires on keyup for elements that declare `onLongPress` and on keydown
// for everything else (see useFocusable). Only VideoCard is in the first group;
// rail rows and EntityCards are in the second, but sending both costs nothing
// and keeps one helper. 10009 is Tizen's Back, which every overlay here handles
// on the capture phase.
async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

async function pressBack() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: 10009, key: 'Escape', bubbles: true, cancelable: true,
  }));
  await sleep(400);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};
/** Cards of a section that are *on screen right now*.
 *
 * Not the same as `cardCount`, which counts registry keys: the registry
 * outlives a card that React has unmounted — the entry still points at a
 * detached node — so a listing that has just been replaced by an empty one
 * still has 40 keys behind it. `document.contains` is the difference between
 * "was rendered" and "is rendered", and only the second one is what the user
 * is looking at. */
const liveCards = (prefix) =>
  [...registry.keys()]
    .filter(k => k.startsWith(`${prefix}-`))
    .filter(k => {
      const el = registry.get(k)?.el;
      return !!el && document.contains(el);
    }).length;
const focusedId = () => getCurrentFocusId();
const has = (id) => registry.has(id);
const cardCount = (prefix) =>
  [...registry.keys()].filter(k => k.startsWith(`${prefix}-`)).length;

// The fake's own logs. `/requests` is the paginated listings and `/graphqlcalls`
// every operation name before dispatch; between them they answer both "which
// operation" and "with what filter variable".
const getJSON = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();
const clearLogs = async () => fetch(`http://127.0.0.1:${PORT}/clear`, { method: 'POST' });
// `/mode` merges the payload into the fake's behaviour switches; each key is
// one arm (`imageInfo: 'slow' | 'fail'`).
const setMode = (key, value) => fetch(`http://127.0.0.1:${PORT}/mode`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ [key]: value }),
});

// The controls bar, derived from where it is rather than from a class name:
// ControlsPanel renders the element immediately above <main>.
const barEl = () => document.querySelector('[role="main"]')?.previousElementSibling;
const barText = () => (barEl()?.textContent || '');

/** Switch tabs the way the remote does: focus the rail row and press Enter. */
async function goto(tab) {
  focus(`nav-${tab}`);
  await sleep(120);
  await tapEnter();
  await sleep(400);
}

const railActive = () =>
  [...(document.querySelector('nav[aria-label="Main navigation"]')?.querySelectorAll('button') ?? [])]
    .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || '(none)';

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
  // Home is the showroom as of 0.15.0, so its first shelf — not a `video-`
  // card — is what arrives over the wire here. The scene listing these
  // sections activate into now lives on Scenes.
  await waitFor(() => has('showroom-recent-scenes-video-1'));
  await sleep(300);

  // ── S1  each section renders, with its own prefix ────────
  // The focus prefix is the id scheme the rails, the Carousel and the
  // activation handlers all key off, so "the right section rendered" is
  // precisely "cards registered under its prefix and not another's".
  const SECTIONS = [
    { tab: 'tags',      prefix: 'tag',     noun: 'tags',      title: 'VERIFY tag 1' },
    { tab: 'studios',   prefix: 'studio',  noun: 'studios',   title: 'VERIFY studio 1' },
    { tab: 'galleries', prefix: 'gallery', noun: 'galleries', title: 'VERIFY gallery 1' },
    { tab: 'images',    prefix: 'image',   noun: 'images',    title: 'VERIFY image 1' },
  ];

  /** The text inside a registered card, read from the element the registry
   *  points at. This is what the user sees on the tile, and it is the only
   *  thing here that distinguishes one section's rows from another's. */
  const cardText = (id) => registry.get(id)?.el.textContent || '';

  for (const s of SECTIONS) {
    await goto(s.tab);
    const ok = await waitFor(() => has(`${s.prefix}-1`));
    const n = cardCount(s.prefix);
    check(`S1 ${s.tab}: the listing renders under its own prefix`,
      ok && n > 0 && railActive().toLowerCase() === s.tab,
      `cards=${n} rail=${railActive()} errors: ${errorTail()}`);
    // ── The content assertion, and why the count above is not enough ──
    // It caught a real bug on 2026-10-16: all four sections render the same
    // `EntityPage`, so React *reconciled* it across a tab switch instead of
    // remounting, `usePagedList` kept the previous section's `items`, and its
    // reset effect never re-ran because none of its deps change between two
    // entity tabs. Every count-based check stayed green — the tile ids are
    // built from the descriptor's prefix, so they read `studio-1`..`studio-40`
    // whatever rows are underneath them, and the fixtures share `id: "1"`.
    // What was actually on screen was Tags' rows wearing Studios' classes.
    // Asserting the *text* is the smallest thing that could have gone red.
    check(`S1 ${s.tab}: the tiles carry this section's rows`,
      cardText(`${s.prefix}-1`).includes(s.title),
      `card 1 says "${cardText(`${s.prefix}-1`).replace(/\s+/g, ' ').slice(0, 60)}"`);
    // The fixture is 100 rows; the count line is the only place the section
    // says how many there are. Asserted as the literal the fake serves, so a
    // section that printed another section's total would show it.
    check(`S1 ${s.tab}: the count line reports the server's total`,
      barText().includes('100') || document.body.textContent.includes('100'),
      `bar="${barText().slice(0, 80)}"`);
  }

  // ── S2  the four operations are the four operations ──────
  // Each section's service is built from one factory with the operation name
  // in its arguments, and a factory is exactly the thing that can be right for
  // three sections and wrong for the fourth without anything failing to
  // render — the wrong operation would still return rows, just not these ones.
  //
  // Read from the whole run's log rather than from a fresh window. The first
  // draft cleared the log and re-entered each tab, which asked nothing: the
  // listings were already in `listCache`, so no request went out and the check
  // failed on an empty log. Re-visiting a tab is not a way to make it fetch —
  // only a change of request identity is — and this is the assertion that says
  // so, so it reads what S1's own visits produced.
  const calls = await getJSON('/graphqlcalls');
  for (const op of ['FindTags', 'FindStudios', 'FindGalleries', 'FindImages']) {
    check(`S2 ${op} was sent`, calls.includes(op), `saw: ${[...new Set(calls)].join(', ')}`);
  }

  // ── S3  the filter variable is the section's own ─────────
  // The fake logs the filter argument under its own key, so this is where a
  // service that passed `tag_filter` to `findImages` shows up. It would have
  // been rejected by the real server; here it would silently return the whole
  // listing, which is why it is asserted against the log rather than the DOM.
  const reqs = await getJSON('/requests');
  const keys = reqs.flatMap(r => Object.keys(r).filter(k => k.endsWith('_filter')));
  check('S3 each listing carried its own filter argument',
    ['tag_filter', 'studio_filter', 'gallery_filter', 'image_filter']
      .every(k => keys.includes(k)),
    `${reqs.length} listings logged; saw ${[...new Set(keys)].join(', ') || '(none)'}`);

  // ── S4  the sort menus offer only values the server accepts ──
  // The values below are a recorded *measurement*, not a derivation. Stash's
  // `SortBy` is one enum shared by every resolver, so introspecting it says
  // which values exist and nothing about which ones a given `findX` honours —
  // and the four disagree with each other in ways a pattern-match gets wrong:
  // Tags take `scenes_count` and `performers_count` (plural), Studios take
  // `tag_count` and `child_count` (singular) and reject `performers_count`
  // outright, Images take `performer_count` and reject `performers_count`.
  // Each list was sent to its own resolver before it was written into App.jsx.
  //
  // The fake cannot help here: it slices a fixture whatever sort it is handed,
  // so a menu of invented values looks perfectly healthy. What is checkable is
  // that every value the menu *offers* is one of the probed ones — and, more
  // to the point, that none of the tempting guesses is among them. That is the
  // assertion with teeth: `performers_count` on Studios is exactly the line a
  // future edit would add by symmetry, and it is a runtime "invalid sort" on
  // the TV.
  const PROBED = {
    tags: ['name', 'created_at', 'updated_at', 'random',
      'scenes_count', 'scene_markers_count', 'images_count', 'galleries_count',
      'performers_count', 'studios_count'],
    studios: ['name', 'created_at', 'updated_at', 'rating', 'random',
      'scenes_count', 'images_count', 'galleries_count', 'tag_count', 'child_count'],
    galleries: ['title', 'created_at', 'updated_at', 'date', 'rating', 'random',
      'images_count', 'file_count', 'performer_count', 'tag_count'],
    images: ['title', 'created_at', 'updated_at', 'date', 'rating', 'random',
      'o_counter', 'filesize', 'resolution', 'performer_count', 'tag_count'],
  };
  const REJECTED = {
    studios: ['performers_count', 'groups_count', 'movies_count'],
    images: ['performers_count', 'files_count', 'galleries_count',
      'studios_count', 'tags_count', 'movies_count'],
    tags: ['files_count', 'file_count', 'resolution', 'filesize'],
    galleries: ['files_count', 'resolution', 'filesize'],
  };

  /** The values the Sort dropdown currently offers, read out of the registry.
   *  The options only mount while the menu is open, so this opens it, reads,
   *  and closes it again — the same three presses a user makes.
   *
   *  While it is open, it also measures the group header and one row. The
   *  header is `position: sticky`, so rows scroll underneath it; with a
   *  translucent background both layers stayed readable at once and the
   *  section name sat on top of an option's text (reported from the TV on
   *  2026-10-18). The harness cannot see that as a paint, but it can see the
   *  two computed styles that cause it. CSS-module names are hashed, hence the
   *  attribute-substring selector. */
  const paintProbes = [];
  async function sortVocabulary() {
    if (!focus('ctrl-sort')) return null;
    await sleep(150);
    await tapEnter();
    await sleep(300);
    const values = [...registry.keys()]
      .filter(k => k.startsWith('ctrl-sort-opt-'))
      .map(k => k.slice('ctrl-sort-opt-'.length));
    const header = document.querySelector('[class*="dropdownGroupHeader"]');
    const item = document.querySelector('[class*="dropdownItem"]');
    if (header) {
      const hs = getComputedStyle(header);
      const bg = hs.backgroundColor || '';
      const opaque = /^rgb\(/.test(bg) || /,\s*1\)$/.test(bg);
      paintProbes.push({
        sticky: hs.position === 'sticky',
        opaque,
        // The top row must be able to rest below the header when the D-pad
        // scrolls it into view; 0 means nothing keeps it clear.
        scrollMargin: item ? parseFloat(getComputedStyle(item).scrollMarginTop) || 0 : 0,
      });
    }
    await press('Escape');
    await sleep(300);
    return values;
  }

  const vocab = {};
  for (const s of SECTIONS) {
    await goto(s.tab);
    vocab[s.tab] = await sortVocabulary();
  }

  // One probe per section with a grouped menu; an empty array would make the
  // check vacuous, so the count is part of the assertion.
  check('S4c grouped sort headers are opaque and sticky, and rows clear them',
    paintProbes.length === SECTIONS.length
      && paintProbes.every(p => p.sticky && p.opaque && p.scrollMargin >= 24),
    paintProbes.length
      ? paintProbes.map((p, i) => `${SECTIONS[i].tab}: sticky=${p.sticky} `
          + `opaque=${p.opaque} margin=${p.scrollMargin}`).join(' | ')
      : 'no grouped header was found while a sort menu was open');

  for (const s of SECTIONS) {
    const got = vocab[s.tab];
    if (!got || !got.length) {
      check(`S4 ${s.tab}: the sort menu opens and lists options`, false,
        `read ${JSON.stringify(got)}; rail ${railActive()}`);
      continue;
    }
    const unknown = got.filter(v => !PROBED[s.tab].includes(v));
    const guessed = got.filter(v => REJECTED[s.tab].includes(v));
    check(`S4 ${s.tab}: every sort offered was probed against the live server`,
      unknown.length === 0,
      unknown.length ? `not in the probed list: ${unknown.join(', ')}` : `${got.length} options`);
    check(`S4 ${s.tab}: none of the rejected guesses is offered`,
      guessed.length === 0,
      guessed.length ? `would fail with "invalid sort": ${guessed.join(', ')}` : 'none present');
  }

  // ── S4d  arriving at Markers fetches page 1 exactly once ──
  // Reported from the TV: "browsing markers tab is sluggish, slower than other
  // tabs. There is like a small delay switching between markers." The delay
  // was not the key handler (measured 0–2 ms, same registry size as Scenes)
  // and not the server (43 ms median): arriving at Markers sent *two* page-1
  // requests. The first carried the sort left over from the previous tab
  // (`created_at`, valid everywhere) and the second Markers' own default
  // (`title`), because the arrival rule ran in a `useEffect` and effects fire
  // child-first — the grid's `usePagedList` reset effect had already fetched
  // before App adopted the tab's controls. The first answer was thrown away.
  // The rule now adjusts `controls` during render, so the grid mounts already
  // sorted and fetches once. This is asserted against the fake's request log
  // rather than the screen: both replies render cards, so the DOM cannot tell
  // one request from two.
  //
  // `markers=paged` is what makes the fake log marker listings at all (its
  // default two-row marker fixture is there for the markerfix checks). The
  // mode is restored afterwards so the rest of the run sees the usual fixture.
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markers: 'paged' }),
  });
  // Images is the tab the vocabulary loop left us on, and its declared sort is
  // `created_at` — the exact value that used to ride into Markers.
  await goto('images');
  await sleep(300);
  await clearLogs();
  await goto('markers');
  await waitFor(() => has('marker-1'));
  await sleep(600); // long enough for a second (stale-sort) fetch to land
  const markerReqs = (await getJSON('/requests')).filter(r => 'scene_marker_filter' in r);
  check('S4d arriving at Markers sends one page-1 request, already Title/ASC',
    markerReqs.length === 1 && markerReqs[0].page === 1
      && markerReqs[0].sort === 'title' && markerReqs[0].direction === 'ASC',
    `${markerReqs.length} marker request(s): `
      + (markerReqs.map(r => `${r.page}@${r.per_page}:${r.sort}:${r.direction}`).join(', ')
        || '(none)'));
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markers: 'default' }),
  });

  // ── S4b  arriving at a section adopts its declared sort *and direction* ──
  // Tags declare `name` + `asc`; before 0.18.0 the tab-change effect only
  // replaced `controls.sort` when the value carried over from the previous tab
  // was *invalid* for the new one. `created_at` is valid for Tags, so a user
  // who sorted Scenes by Date Added and then opened Tags got Date Added there
  // too, and Tags' declared default was never applied to anyone who had
  // touched a sort first. 0.18.1 adds the other half: `order` was never
  // adopted at all, so Tags opened on Name *and* Descending (the TV pass
  // caught it). The effect now adopts both on every arrival, and this is the
  // check that pins it: set Tags to Date Added + DESC, leave for Images, come
  // back — Tags must read Name + ASC. The control is the assertion because the
  // page-1 fetch is a cache hit.
  await goto('tags');
  await waitFor(() => has('ctrl-sort'));
  const sortTrigger = () => registry.get('ctrl-sort')?.el.textContent?.trim() ?? '(none)';
  // Direction is a pair of `aria-pressed` toggles (`ctrl-asc` / `ctrl-desc`),
  // not a text control, so read the pressed state rather than a label.
  const orderIs = () => {
    if (registry.get('ctrl-asc')?.el.getAttribute('aria-pressed') === 'true') return 'ASC';
    if (registry.get('ctrl-desc')?.el.getAttribute('aria-pressed') === 'true') return 'DESC';
    return '(none)';
  };

  let choseDateAdded = false;
  let choseDesc = false;
  if (focus('ctrl-sort')) {
    await sleep(150);
    await tapEnter();
    const offered = await waitFor(() => registry.has('ctrl-sort-opt-created_at'), 2000);
    if (offered) {
      focus('ctrl-sort-opt-created_at');
      await sleep(80);
      await tapEnter();
      await sleep(400);
      choseDateAdded = sortTrigger() === 'Date Added';
    } else {
      await press('Escape');
    }
  }
  // Leave the direction explicitly on Descending. Arriving at Tags with Name +
  // Asc must flip it back; without that, the arrival'd read DESC and S4b goes
  // red (the 0.18.0 bug the TV pass caught).
  if (focus('ctrl-desc')) {
    await sleep(80);
    await tapEnter();
    await sleep(250);
    choseDesc = orderIs() === 'DESC';
  }

  await goto('images');
  await sleep(400);
  await goto('tags');
  await waitFor(() => has('ctrl-sort'));
  await sleep(300);
  check('S4b Tags returns to its declared default sort and direction, not the ones it was left on',
    choseDateAdded && choseDesc && railActive() === 'Tags'
      && sortTrigger() === 'Name' && orderIs() === 'ASC',
    `left on Date Added=${choseDateAdded}, DESC=${choseDesc}; back on Tags reads `
      + `"${sortTrigger()}" / ${orderIs()}`);
  // Tags is now on ASC. Leaving it for a date-sorted tab must reset the
  // direction to Desc — otherwise every other tab would open oldest-first
  // after a visit to Tags. Read after the return for exactly that reason.
  await goto('images');
  await sleep(400);
  const imagesOrder = orderIs();
  check('S4b2 Tags\' ascending does not leak onto a date-sorted tab',
    imagesOrder === 'DESC',
    `Images read ${imagesOrder} after leaving Tags, which is on ASC`);

  // ── S4c  Performers, Markers and Studios arrive name/title-ascending ──
  // Reported from the TV, 2026-10-18: "these should have default sort as title
  // ascending: Markers, Performers." Then: "Studios should be arranged by
  // title ascending." Markers already declared `title` but no direction;
  // Performers declared `created_at`; Studios declared `name` but inherited
  // the session's DESC. All three now carry `defaultOrder: 'asc'`
  // (Performers and Studios on `name` — Stash's sort value is not `title`).
  // Same shape as S4b: deliberately leave the tab on Date Added + DESC, go
  // elsewhere, come back and require the declared pair.
  for (const [tab, expectedLabel] of
    [['performers', 'Name'], ['markers', 'Title'], ['studios', 'Name']]) {
    await goto(tab);
    await waitFor(() => has('ctrl-sort'));
    let choseDateAdded = false;
    let choseDesc = false;
    if (focus('ctrl-sort')) {
      await sleep(150);
      await tapEnter();
      const offered = await waitFor(() => registry.has('ctrl-sort-opt-created_at'), 2000);
      if (offered) {
        focus('ctrl-sort-opt-created_at');
        await sleep(80);
        await tapEnter();
        await sleep(300);
        choseDateAdded = sortTrigger() === 'Date Added';
      } else {
        await press('Escape');
      }
    }
    if (focus('ctrl-desc')) {
      await sleep(80);
      await tapEnter();
      await sleep(250);
      choseDesc = orderIs() === 'DESC';
    }

    await goto('images');
    await sleep(350);
    await goto(tab);
    await waitFor(() => has('ctrl-sort'));
    await sleep(300);
    check(`S4c ${tab} returns to ${expectedLabel} ascending, not the sort it was left on`,
      choseDateAdded && choseDesc && railActive().toLowerCase() === tab
        && sortTrigger() === expectedLabel && orderIs() === 'ASC',
      `left on Date Added=${choseDateAdded}, DESC=${choseDesc}; back on ${tab} reads `
        + `"${sortTrigger()}" / ${orderIs()}`);
  }

  // ── S5  activating a tag lands on Scenes, still filtered ─
  // The whole of this phase's one non-obvious design decision. Activating a tag
  // switches tab and sets `controls.workingFilter` in the same React batch, so
  // the tab-change effect runs with a filter that the tab change itself applied
  // — and the pre-0.11.0 effect cleared it unconditionally. This check is the
  // one that goes red when that happens: the grid renders, the request goes
  // out, and it is unfiltered.
  await goto('tags');
  await waitFor(() => has('tag-3'));
  await clearLogs();
  focus('tag-3');
  await sleep(120);
  await tapEnter();
  await sleep(600);

  check('S5 activating a tag switches to Scenes',
    railActive() === 'Scenes', `rail says ${railActive()}`);
  // ── `.at(-1)`, not `.find()` — and this is the whole check ──
  // The first draft used `.find()`, which asks "was a filtered scene request
  // sent at some point during this activation". It was: the batch sets the
  // filter and the tab together, so ScenesPage mounts *already* filtered and its
  // first fetch carries the criterion — and then the tab-change effect runs,
  // drops the filter if it cannot tell arrival from departure, and the grid
  // refetches unfiltered on top of it. Both requests are in the log, `.find()`
  // sees the first, and the check passes on exactly the bug it was written for.
  // Measured, not reasoned: with `workingFilterFor` deleted from the activation
  // the `.find()` form stayed green. The last request is what the screen is
  // showing, so the last request is what is asserted.
  const afterTag = await getJSON('/requests');
  const sceneReqs = afterTag.filter(r => r.scene_filter);
  const last = sceneReqs[sceneReqs.length - 1];
  check('S5 the criterion reached the wire',
    !!last && last.scene_filter.tags?.value?.[0] === '3',
    `${sceneReqs.length} scene listing(s); last scene_filter=${JSON.stringify(last?.scene_filter ?? null)}`);

  // ── And this is the check that can actually fail ──
  // The one above cannot: the batch sets the filter and the tab together, so
  // the filtered request is always sent, whatever the tab-change effect does
  // next. What the effect does next is the whole question — and it is invisible
  // in the request log, because the refetch a *dropped* filter triggers asks
  // for page 1 of the unfiltered listing, which `listCache` has held since
  // mount. So it is read off the screen instead: the fake honours a `tags`
  // criterion by returning nothing (no scene in the fixture carries a tag), so
  // a Scenes that is still filtered shows no video cards and a Scenes that
  // dropped the filter shows forty. Both halves were measured — deleting
  // `workingFilterFor` from the activation leaves this red and the log form
  // green.
  await waitFor(() => liveCards('video') === 0, 2000);
  const sceneCards = liveCards('video');
  check('S5 and the Scenes listing is still filtered, not refetched unfiltered',
    sceneCards === 0,
    `${sceneCards} video card(s) on screen`);
  check('S5 the dropdown names the tag rather than "Custom filter"',
    /VERIFY tag 3/.test(barText()),
    `bar="${barText().slice(0, 100)}"`);

  // ── S6  a studio does the same, and a gallery goes elsewhere ──
  // The gallery case is the interesting one: it lands on Images, not Scenes,
  // so a handler that hard-coded one destination would be wrong for it and
  // right for the other two.
  await goto('galleries');
  await waitFor(() => has('gallery-2'));

  // ── S6a  the gallery card's second line ─────────────────
  // Studio when there is one, the folder otherwise (which on a real library is
  // the field that is almost always present). The fixture makes both cases
  // decidable in the first three rows: gallery 1 carries BOTH a studio and a
  // folder, so "studio wins" is visible, and gallery 3 carries no studio at
  // all, so the fallback is visible. Every value is VERIFY-prefixed, so a card
  // printing the wrong field cannot pass on incidental text.
  check('S6a the gallery card names the studio when there is one',
    cardText('gallery-1').includes('4 images · VERIFY gallery studio 1'),
    `card 1 says "${cardText('gallery-1').replace(/\s+/g, ' ').slice(0, 90)}"`);
  check('S6a …and falls back to the folder when the studio is empty',
    cardText('gallery-3').includes('12 images · VERIFY folder 3')
      && !cardText('gallery-3').includes('VERIFY gallery studio 3'),
    `card 3 says "${cardText('gallery-3').replace(/\s+/g, ' ').slice(0, 90)}"`);

  await clearLogs();
  focus('gallery-2');
  await sleep(120);
  await tapEnter();
  await sleep(600);
  const afterGallery = await getJSON('/requests');
  // Same `.at(-1)` as S5, for the same measured reason.
  const imgReqs = afterGallery.filter(r => 'image_filter' in r);
  const lastImg = imgReqs[imgReqs.length - 1];
  check('S6 activating a gallery switches to Images',
    railActive() === 'Images', `rail says ${railActive()}`);
  check('S6 the criterion reached the wire',
    !!lastImg && lastImg.image_filter?.galleries?.value?.[0] === '2',
    `${imgReqs.length} image listing(s); last image_filter=${JSON.stringify(lastImg?.image_filter ?? null)}`);
  // The gallery half of S5's second check, for the same measured reason: the
  // fake returns nothing for an `galleries` criterion, so a filtered Images
  // section is empty on screen and an unfiltered one is not.
  await waitFor(() => liveCards('image') === 0, 2000);
  const imgCards = liveCards('image');
  check('S6 and Images is still filtered to that gallery',
    imgCards === 0, `${imgCards} image card(s) on screen`);

  // ── S7  Back out of a filtered Scenes returns to Tags ───
  // Not to Scenes-with-no-filter and not to the exit prompt. The prompt is the
  // specific wrong answer: it is what the app does when nothing claims Back,
  // so a check that only asserted "the rail says Tags" would also pass on a
  // build where Back raised the dialog and the dialog's own Back closed it.
  await goto('tags');
  await waitFor(() => has('tag-3'));
  focus('tag-3');
  await sleep(120);
  await tapEnter();
  await sleep(600);
  await pressBack();

  check('S7 Back returns to Tags', railActive() === 'Tags', `rail says ${railActive()}`);
  check('S7 and there is no exit prompt in the way',
    !document.querySelector('[role="dialog"]'),
    document.querySelector('[role="dialog"]') ? 'a dialog is open' : 'no dialog');
  // The focus restore is a retry loop, not a fixed delay — see
  // focusByIdWhenReady — so this waits rather than sleeping a guessed interval.
  const restored = await waitFor(() => focusedId() === 'tag-3', 3000);
  check('S7 focus is back on the tag that was pressed', restored, `focus: ${focusedId()}`);

  // ── S8  the filter is dropped on the way out ────────────
  // Returning to Tags with the scene filter still set would be worse than not
  // returning at all: the Tags tab would then be carrying a criterion for a
  // listing it does not show, and the next tag activation would have to
  // displace it rather than set it.
  await goto('scenes');
  check('S8 Scenes is unfiltered after backing out',
    !/VERIFY tag 3/.test(barText()),
    `bar="${barText().slice(0, 100)}"`);
  // The complement of S5's second check, and the reason it is worth having
  // both: S5 says the filter survives an arrival, this says it does not
  // outlive a departure. A build that never cleared `workingFilter` would pass
  // every other check in this file and show an empty Scenes forever.
  await waitFor(() => liveCards('video') > 0, 3000);
  check('S8 …and its listing is back, not left empty by a stale filter',
    liveCards('video') > 0, `${liveCards('video')} video card(s) on screen`);

  // ── S9  an image opens the viewer ───────────────────────
  await goto('images');
  await waitFor(() => has('image-1'));
  focus('image-1');
  await sleep(120);
  await tapEnter();
  await sleep(500);
  const viewer = document.querySelector('[role="dialog"][aria-modal="true"]');
  check('S9 Enter on an image opens the viewer', !!viewer,
    viewer ? 'dialog present' : `no dialog; errors: ${errorTail()}`);
  if (!viewer) { await finish(); return; }

  // ── S10  it shows the full image, not the thumbnail ─────
  // The two are different URLs on the fake (`/image/n/thumb.png` vs
  // `/image/n/full.png`) precisely so this is decidable. A viewer wired to the
  // card's own `image_path` would look identical on a server where they agreed.
  const img = viewer.querySelector('img');
  check('S10 the viewer shows paths.image, not the thumbnail',
    !!img && /\/image\/1\/full\.png/.test(img.getAttribute('src')),
    `src=${img?.getAttribute('src') ?? '(no img)'}`);
  check('S10 and the thumbnail is not what it opened',
    !!img && !/\/image\/1\/thumb\.png/.test(img.getAttribute('src')),
    'thumb and full are distinct routes on the fake');

  // ── S10b  the info panel is reachable, and asks once ────
  // The surface holds focus after opening, and the panel's only D-pad route
  // in is the header button. A `nextId` pointing at an id that never
  // registers would leave the panel unreachable without a pointer, which this
  // app does not have.
  const infoPanel = () => document.querySelector('aside[aria-label="Image info"]');
  const panelText = () => (infoPanel()?.textContent || '');
  const imageInfoFetches = async () => getJSON('/imageinfofetches');

  await press('ArrowUp');
  check('S10b Up from the picture reaches the Info button',
    focusedId() === 'image-viewer-info', `focus: ${focusedId()}`);

  await tapEnter();
  const panelUp = await waitFor(() => !!infoPanel(), 2000);
  await waitFor(() => /VERIFY image studio 1/.test(panelText()), 3000);
  const info1 = await imageInfoFetches();
  check('S10b Enter on Info opens the panel and asks once for this image',
    panelUp && info1.length === 1 && info1[0].id === '1',
    `open=${panelUp}; fetches=${JSON.stringify(info1.map(f => f.id))}`);
  // `visual_files` is the union field Image carries; `files` does not exist on
  // Image at all, and the fake would happily answer either. The query text is
  // the only place the difference is visible.
  check('S10b the query asks for visual_files, not the invalid `files`',
    info1.length === 1 && info1[0].query.includes('visual_files'),
    info1.length ? info1[0].query.replace(/\s+/g, ' ').slice(0, 120) : '(no fetch)');
  check('S10b the panel shows the metadata, formatted rather than raw',
    /VERIFY image studio 1/.test(panelText())
      && /4000×3000/.test(panelText())
      && /5 MiB/.test(panelText()),
    panelText().replace(/\s+/g, ' ').slice(0, 140));
  // 8 tags / 7 performers / 6 galleries in the fixture: the caps are what
  // keeps a metadata panel from becoming a wall of text at 1080p.
  check('S10b long lists are capped with a +N count',
    /\+2/.test(panelText()) && /\+1/.test(panelText()),
    panelText().replace(/\s+/g, ' ').slice(0, 160));
  // The panel is read-only, and the app is D-pad-only: a focusable inside it
  // would be an invisible stop with nothing to press it for.
  const insidePanel = [...registry.entries()]
    .filter(([, e]) => e.el && infoPanel()?.contains(e.el))
    .map(([id]) => id);
  check('S10b the panel adds no focus stops of its own',
    insidePanel.length === 0, `registered inside: ${insidePanel.join(', ') || '(none)'}`);

  // ── S10c  Back peels one layer at a time ────────────────
  // The panel is on top of the viewer, so one Back must not close both — that
  // would make the viewer's own Back unreachable while the panel is open.
  await pressBack();
  const panelClosed = await waitFor(() => !infoPanel(), 2000);
  check('S10c Back closes the panel, not the viewer',
    panelClosed && !!document.querySelector('[role="dialog"][aria-modal="true"]'),
    panelClosed
      ? (document.querySelector('[role="dialog"][aria-modal="true"]')
        ? 'panel closed, viewer still open' : 'viewer closed too')
      : 'panel still open');

  // Reopening the same image is a cache hit. The fake's fetch log is the only
  // place a cache can be observed — the screen looks identical either way.
  await press('ArrowUp');
  await tapEnter();
  await waitFor(() => /VERIFY image studio 1/.test(panelText()), 3000);
  const info1b = await imageInfoFetches();
  check('S10d reopening the panel for the same image is a cache hit',
    info1b.length === 1,
    `${info1b.length} fetch(es): ${JSON.stringify(info1b.map(f => f.id))}`);
  await pressBack();
  await waitFor(() => !infoPanel(), 2000);

  // ── S11  Left/Right step through the listing ────────────
  const titleOf = () => viewer.querySelector('h2')?.textContent || '';
  const before = titleOf();
  await press('ArrowRight');
  const after = titleOf();
  check('S11 Right steps to the next image',
    after !== before && /image 2\b/.test(after), `"${before}" → "${after}"`);
  await press('ArrowLeft');
  check('S11 Left steps back', titleOf() === before, `"${titleOf()}" vs "${before}"`);

  // ── S11b  one fetch per image the panel is opened on ────
  // Browsing with the panel closed is free (S11 left the log at one entry);
  // opening a second image asks exactly once more; stepping back to a seen
  // image is a cache hit. All three are read from the fake's log, because the
  // screen cannot tell a cached answer from a fresh one.
  await press('ArrowRight');            // image 1 → 2
  await press('ArrowUp');
  await tapEnter();
  await waitFor(() => /VERIFY image studio 2/.test(panelText()), 4000);
  const info2 = await imageInfoFetches();
  check('S11b opening a second image asks once for that image',
    info2.length === 2 && info2[1].id === '2',
    `${info2.length} fetch(es): ${JSON.stringify(info2.map(f => f.id))}`);

  // The Info button holds focus here — opening the panel does not move it —
  // and Left/Right must still browse. Before 0.29.1 the capture handler
  // ignored the arrows unless the picture itself held focus, so a step needed
  // a Down press first; reported from the TV as "only works after closing the
  // panel". Both targets are cached, so this must not add a fetch.
  await press('ArrowLeft');             // image 2 → 1, panel stays open
  const steppedWithInfo = await waitFor(
    () => /image 1\b/.test(titleOf()) && /VERIFY image studio 1/.test(panelText()),
    3000,
  );
  check('S11b Left steps while the Info button holds focus',
    steppedWithInfo && focusedId() === 'image-viewer-info' && !!infoPanel(),
    `"${titleOf()}"; focus: ${focusedId()}; panel=${!!infoPanel()}`);
  // Compare against the title *before* the press: on the old guard both
  // presses were no-ops, so "we are on image 2 with studio 2 showing" was
  // already true and the check passed on the broken build. The title must
  // actually change.
  const beforeRight = titleOf();
  await press('ArrowRight');            // back to image 2
  const steppedBackWithInfo = await waitFor(
    () => /image 2\b/.test(titleOf()) && /VERIFY image studio 2/.test(panelText()),
    3000,
  );
  check('S11b …and Right steps back with the panel still open',
    steppedBackWithInfo && beforeRight !== titleOf(),
    `"${beforeRight}" → "${titleOf()}"`);
  await pressBack();
  await waitFor(() => !infoPanel(), 2000);
  await press('ArrowLeft');             // back to image 1
  await press('ArrowUp');
  await tapEnter();
  await waitFor(() => /VERIFY image studio 1/.test(panelText()), 3000);
  const info2b = await imageInfoFetches();
  check('S11b stepping back to a seen image is a cache hit',
    info2b.length === 2,
    `${info2b.length} fetch(es): ${JSON.stringify(info2b.map(f => f.id))}`);
  await pressBack();
  await waitFor(() => !infoPanel(), 2000);

  // ── S11c  a slow answer cannot land on the image stepped to ──
  // Slow mode makes the race explicit. The panel is opened on image 3, Down
  // returns focus to the picture with the panel still open, and Right steps to
  // image 4 while image 3's request is still in flight. The fixture names the
  // studio after the requested id, so "the stale answer was drawn" is
  // visible; sampling while answer 4 is *still* in flight is what makes the
  // check able to fail — a later sample would be correct whatever happened,
  // because the right answer eventually overwrites the wrong one.
  await setMode('imageInfo', 'slow');
  await press('ArrowRight');            // image 1 → 2
  await press('ArrowRight');            // image 2 → 3 (uncached)
  await press('ArrowUp');
  await tapEnter();
  await sleep(120);
  const slowBegun = (await imageInfoFetches()).map(f => f.id);
  check('S11c the slow image’s request is in flight',
    slowBegun[slowBegun.length - 1] === '3'
      && /Loading info/.test(panelText()),
    `fetches=${JSON.stringify(slowBegun)}; panel="${panelText().slice(0, 60)}"`);

  await press('ArrowDown');             // back to the picture, panel stays open
  check('S11c Down returns to the picture with the panel still open',
    focusedId() === 'image-viewer' && !!infoPanel(),
    `focus: ${focusedId()}; panel=${!!infoPanel()}`);
  await press('ArrowRight');            // image 3 → 4, panel open

  // The fake sleeps 1.2 s before answering. Answer 3 is due ~1.21 s after the
  // panel opened and answer 4 ~0.45 s later; ~1.31 s in, exactly the stale
  // answer has arrived and the live one has not.
  await sleep(700);
  const midText = panelText();
  check('S11c the answer for the image stepped away from never lands on the new one',
    /Loading info/.test(midText) && !/VERIFY image studio 3/.test(midText),
    midText.replace(/\s+/g, ' ').slice(0, 120));
  await waitFor(() => /VERIFY image studio 4/.test(panelText()), 3000);
  check('S11c …and the live image’s own answer does',
    /VERIFY image studio 4/.test(panelText()),
    panelText().replace(/\s+/g, ' ').slice(0, 120));
  await pressBack();                    // close the panel
  await waitFor(() => !infoPanel(), 2000);

  // ── S11d  a failure is reported, and not remembered ─────
  // A cached failure would look exactly like a working panel the second time:
  // same message, no request. The fetch count is what distinguishes them.
  await setMode('imageInfo', 'fail');
  await press('ArrowRight');            // image 4 → 5
  await press('ArrowUp');
  await tapEnter();
  const failedShown = await waitFor(() => /Couldn't load info/.test(panelText()), 4000);
  check('S11d a failed info request is reported, not hidden behind an empty panel',
    failedShown && /simulated image info failure/.test(panelText()),
    `shown=${failedShown}; panel="${panelText().replace(/\s+/g, ' ').slice(0, 100)}"`);
  const failedOnce = (await imageInfoFetches()).length;
  await pressBack();
  await waitFor(() => !infoPanel(), 2000);
  await press('ArrowUp');
  await tapEnter();
  await waitFor(() => /Couldn't load info/.test(panelText()), 4000);
  const failedTwice = (await imageInfoFetches()).length;
  check('S11d a failure is not cached — reopening retries',
    failedTwice === failedOnce + 1, `${failedOnce} → ${failedTwice}`);
  await setMode('imageInfo', 'ok');
  await pressBack();
  await waitFor(() => !infoPanel(), 2000);

  // Back on image 1, which is the card S12's focus restore is about.
  for (let i = 0; i < 4; i += 1) await press('ArrowLeft');
  check('S11e stepped back to the opening image', titleOf() === before, `"${titleOf()}"`);

  // ── S12  Back closes it and returns focus to the card ───
  await pressBack();
  check('S12 Back closes the viewer',
    !document.querySelector('[role="dialog"][aria-modal="true"]'),
    document.querySelector('[role="dialog"]') ? 'still open' : 'closed');
  const backFocus = await waitFor(() => focusedId() === 'image-1', 2000);
  check('S12 focus returns to the card', backFocus, `focus: ${focusedId()}`);

  // ── S15  columns are per section, and remembered ─────────
  //
  // The grid column count used to be one value shared by every tab, so a
  // performer card (3:4 portrait) was laid out at Scenes' 4 columns and read
  // as oversized — reported from the TV, 2026-10-17. The fix is a per-tab
  // count persisted in the settings store: Performers defaults to 6, every
  // other section to 4, and a change on one tab is remembered for that tab
  // and only that tab.
  //
  // Asserted through the rendered grid's inline `grid-template-columns`,
  // which is what the columns actually do — not through localStorage, which
  // would be green on a store that saves a value nobody renders. The
  // persistence is then asserted separately, because a value that renders
  // but is forgotten on the next launch is exactly the bug settings.js has
  // shipped before.
  const gridCols = () => {
    const el = Array.from(document.querySelectorAll('[role="grid"]'))
      .find(g => g.style.gridTemplateColumns);
    const n = el?.style.gridTemplateColumns.match(/repeat\((\d+)/);
    return n ? Number(n[1]) : null;
  };
  const storedCols = () => {
    try { return JSON.parse(localStorage.getItem('tvapp.settings.v1') || '{}').gridCols || {}; }
    catch { return {}; }
  };

  await goto('performers');
  await waitFor(() => has('performer-1'));
  await sleep(300);
  check('S15 Performers defaults to six columns', gridCols() === 6,
    `rendered ${gridCols()} columns`);

  const dec = registry.get('grid-cols-dec');
  check('S15b the Columns stepper is reachable from the D-pad', !!dec);
  if (dec) {
    dec.el.focus();
    await sleep(60);
    await tapEnter();
    await sleep(250);
  }
  check('S15c the stepper changes the rendered grid', gridCols() === 5,
    `rendered ${gridCols()} columns`);
  check('S15d the count was written to the section’s setting',
    storedCols().performers === 5,
    `stored ${JSON.stringify(storedCols())}`);

  // A different section keeps its own default, which is the half the shared
  // `controls` object used to get wrong in the other direction: switching
  // tabs carried the count across.
  await goto('scenes');
  await waitFor(() => has('video-1'));
  await sleep(300);
  check('S15e Scenes still renders its own four columns', gridCols() === 4,
    `rendered ${gridCols()} columns`);

  // …and coming back restores Performers' remembered count rather than the
  // default, or Scenes'.
  await goto('performers');
  await waitFor(() => has('performer-1'));
  await sleep(300);
  check('S15f Performers reopens at the remembered count', gridCols() === 5,
    `rendered ${gridCols()} columns`);

  // Put it back so a re-run of this driver starts from the default. Storage
  // is per-driver, but the tab is left the way S14 (focus still somewhere)
  // expects to find it.
  if (dec) {
    const inc = registry.get('grid-cols-inc');
    if (inc) { inc.el.focus(); await sleep(60); await tapEnter(); await sleep(250); }
  }

  // ── S13  nothing threw ──────────────────────────────────
  check('S13 no uncaught error during the run', errors.length === 0, errorTail());

  check('S14 every press left focus somewhere', !!focusedId(), `focus: ${focusedId()}`);
}

const root = document.getElementById('root');
document.body.style.margin = '0';

setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(root).render(<App />);

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
