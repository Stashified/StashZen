/**
 * Headless driver for the four browse-only sections (Tags, Studios, Galleries,
 * Images) and the image viewer.
 *
 * Mounts the whole `App`, like rail-entry: nearly every claim is a property of
 * two components together, the grid and its service, the card and its tab,
 * the activation and the tab it switches to. The four sections are instances
 * of one component, so shape and paging are covered by list-entry; this file
 * asserts where they differ.
 *
 *   S1     each section renders under its prefix with its own rows and count;
 *          text, not count, because tile ids come from the prefix and a count
 *          stays green over the previous section's rows (the `key={activeTab}` bug).
 *   S2/S3  its own operation and filter variable; one factory can be wrong for
 *          a section and still render rows.
 *   S4     every offered sort was probed against the live server, and no
 *          rejected guess is offered.
 *   S4b/S4b2 arriving adopts the declared sort *and direction*; the asc must
 *          not leak onto a date-sorted tab on the way out.
 *   S4c    grouped sort headers are sticky and opaque; rows clear them.
 *   S4c    Performers, Markers and Studios return to name/title ascending.
 *   S4d    arriving at Markers sends one page-1 request, already Title/ASC;
 *          the rule adjusts `controls` during render, and both replies render.
 *   S5–S8  a tag filters Scenes via a tab switch: arrival keeps the filter,
 *          Back returns the right card, departure drops it. Read the screen:
 *          a dropped filter's page-1 refetch is a `listCache` hit.
 *   S6a    a gallery card shows its studio, falling back to the folder.
 *   S9–S11 the viewer shows `paths.image`, not the card's thumbnail.
 *   S10b–S11d the info panel: one fetch per image, reopen and step-back are
 *          cache hits, a stale answer never lands, Back peels the panel first,
 *          failures are reported and not cached, and there are no focus stops.
 *
 * Control experiments: deleting `key={activeTab}` reddens S1's content checks,
 * S2 (three operations) and S3 while S1's counts stay green; deleting
 * `workingFilterFor` reddens S5's listing/dropdown and S6's listing; deleting
 * `filterOrigin` in `onBack` reddens all of S7 and both of S8.
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

// Enter fires on keyup for elements declaring `onLongPress` (VideoCard) and on
// keydown for the rest; sending both keeps one helper. 10009 is Tizen's Back,
// which every overlay here handles on the capture phase.
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
 * Not `cardCount`, which counts registry keys: the registry outlives an
 * unmounted card, so a replaced listing still has keys behind it.
 * `document.contains` is the difference between "was rendered" and "is
 * rendered". */
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

// The fake's logs: `/requests` carries the paginated listings and
// `/graphqlcalls` every operation name before dispatch. Together they answer
// "which operation" and "with what filter variable".
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
  // Home is the showroom, so its first shelf, not a `video-` card, arrives
  // over the wire; the scene listing these sections activate into is Scenes.
  await waitFor(() => has('showroom-recent-scenes-video-1'));
  await sleep(300);

  // ── S1  each section renders, with its own prefix ────────
  // The focus prefix is the id scheme the rails, Carousel and activation
  // handlers key off, so "the right section rendered" means cards registered
  // under its prefix and not another's.
  const SECTIONS = [
    { tab: 'tags',      prefix: 'tag',     noun: 'tags',      title: 'VERIFY tag 1' },
    { tab: 'studios',   prefix: 'studio',  noun: 'studios',   title: 'VERIFY studio 1' },
    { tab: 'galleries', prefix: 'gallery', noun: 'galleries', title: 'VERIFY gallery 1' },
    { tab: 'images',    prefix: 'image',   noun: 'images',    title: 'VERIFY image 1' },
  ];

  /** The text inside a registered card, read from the element the registry
   *  points at: what the user sees on the tile, and the only thing that
   *  distinguishes one section's rows from another's. */
  const cardText = (id) => registry.get(id)?.el.textContent || '';

  for (const s of SECTIONS) {
    await goto(s.tab);
    const ok = await waitFor(() => has(`${s.prefix}-1`));
    const n = cardCount(s.prefix);
    check(`S1 ${s.tab}: the listing renders under its own prefix`,
      ok && n > 0 && railActive().toLowerCase() === s.tab,
      `cards=${n} rail=${railActive()} errors: ${errorTail()}`);
    // ── The content assertion, and why the count above is not enough ──
    // All four sections render the same `EntityPage`, so React reconciles it
    // and `usePagedList` keeps the previous items. Counts stay green because
    // tile ids come from the prefix; text is the smallest visible failure.
    check(`S1 ${s.tab}: the tiles carry this section's rows`,
      cardText(`${s.prefix}-1`).includes(s.title),
      `card 1 says "${cardText(`${s.prefix}-1`).replace(/\s+/g, ' ').slice(0, 60)}"`);
    // The fixture is 100 rows; the count line is the only place the section
    // states the total, so another section's number would show here.
    check(`S1 ${s.tab}: the count line reports the server's total`,
      barText().includes('100') || document.body.textContent.includes('100'),
      `bar="${barText().slice(0, 80)}"`);
  }

  // ── S2  the four operations are the four operations ──────
  // One factory builds each service from the operation name, so it can be
  // right for three sections and wrong for the fourth while still returning
  // rows. Read S1's visits: `listCache` makes a re-visit send no request.
  const calls = await getJSON('/graphqlcalls');
  for (const op of ['FindTags', 'FindStudios', 'FindGalleries', 'FindImages']) {
    check(`S2 ${op} was sent`, calls.includes(op), `saw: ${[...new Set(calls)].join(', ')}`);
  }

  // ── S3  the filter variable is the section's own ─────────
  // The fake logs the filter argument under its own key, so a service passing
  // `tag_filter` to `findImages`, rejected by the real server, but silently
  // returning the whole listing here, shows up in the log, not the DOM.
  const reqs = await getJSON('/requests');
  const keys = reqs.flatMap(r => Object.keys(r).filter(k => k.endsWith('_filter')));
  check('S3 each listing carried its own filter argument',
    ['tag_filter', 'studio_filter', 'gallery_filter', 'image_filter']
      .every(k => keys.includes(k)),
    `${reqs.length} listings logged; saw ${[...new Set(keys)].join(', ') || '(none)'}`);

  // ── S4  the sort menus offer only values the server accepts ──
  // These lists record what each resolver accepts, not a derivation: `SortBy`
  // is one shared enum, and the four disagree, Tags take `scenes_count` and
  // `performers_count` (plural), Studios `tag_count`/`child_count` (singular)
  // and reject `performers_count`, Images take `performer_count`. Each was
  // sent to its own resolver first. The fake slices whatever sort it is handed,
  // so the check is that every offered value was probed and the tempting
  // `performers_count`-on-Studios guess is absent.
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

  /** The Sort dropdown's offered values, read from the registry: the options
   *  mount only while open, so this opens, reads and closes.
   *
   *  It also measures the sticky header and a row: a translucent header lets
   *  rows show through. The harness sees computed styles, not paint;
   *  CSS-module names are hashed, hence the substring selector. */
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

  // One probe per section with a grouped menu. An empty array would make the
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
  // The arrival rule was a `useEffect`; effects fire child-first, so the grid
  // fetched with the previous tab's `created_at` before App adopted `title`,
  // and the first answer was discarded. It now adjusts `controls` during
  // render. Read the log: both replies render cards. `markers=paged` makes the
  // fake log marker listings at all; restore it afterwards.
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markers: 'paged' }),
  });
  // Images is where the vocabulary loop left us, and its declared sort is
  // `created_at`, the value that used to ride into Markers.
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
  // Tags declare `name` + `asc`. The effect once replaced only an invalid sort,
  // so valid `created_at` survived, and never adopted `order`. Leave Tags on
  // Date Added + DESC, visit Images, return: it must read Name + ASC. The
  // arrival is the control; the page-1 fetch is a cache hit.
  await goto('tags');
  await waitFor(() => has('ctrl-sort'));
  const sortTrigger = () => registry.get('ctrl-sort')?.el.textContent?.trim() ?? '(none)';
  // Direction is a pair of `aria-pressed` toggles (`ctrl-asc` / `ctrl-desc`),
  // not a text control, so read the pressed state.
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
  // Leave the direction explicitly on Descending: arrival with Name + Asc must
  // flip it back, or this reads DESC.
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
  // Leaving Tags (now ASC) for a date-sorted tab must reset direction to DESC,
  // or every other tab opens oldest-first after a visit to Tags.
  await goto('images');
  await sleep(400);
  const imagesOrder = orderIs();
  check('S4b2 Tags\' ascending does not leak onto a date-sorted tab',
    imagesOrder === 'DESC',
    `Images read ${imagesOrder} after leaving Tags, which is on ASC`);

  // ── S4c  Performers, Markers and Studios arrive name/title-ascending ──
  // All three carry `defaultOrder: 'asc'`: Markers on `title`, Performers and
  // Studios on `name` (Stash's sort value is not `title`). Same shape as S4b:
  // leave on Date Added + DESC, go elsewhere, return and require the pair.
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
  // Activation switches tab and sets `controls.workingFilter` in one React
  // batch, so the tab-change effect sees a filter the change itself applied;
  // clearing it unconditionally leaves the grid rendered but unfiltered.
  await goto('tags');
  await waitFor(() => has('tag-3'));
  await clearLogs();
  focus('tag-3');
  await sleep(120);
  await tapEnter();
  await sleep(600);

  check('S5 activating a tag switches to Scenes',
    railActive() === 'Scenes', `rail says ${railActive()}`);
  // ── `.at(-1)`, not `.find()`, and this is the whole check ──
  // The batch sets filter and tab together, so a filtered request is always
  // sent first; if the effect then drops the filter, the grid refetches
  // unfiltered on top. `.find()` sees the first and passes on exactly that
  // bug. The last request is what the screen shows.
  const afterTag = await getJSON('/requests');
  const sceneReqs = afterTag.filter(r => r.scene_filter);
  const last = sceneReqs[sceneReqs.length - 1];
  check('S5 the criterion reached the wire',
    !!last && last.scene_filter.tags?.value?.[0] === '3',
    `${sceneReqs.length} scene listing(s); last scene_filter=${JSON.stringify(last?.scene_filter ?? null)}`);

  // ── The check that can actually fail ──
  // The one above cannot: the batch always sends the filtered request. A
  // dropped filter's refetch is page 1 of an unfiltered listing `listCache`
  // already holds, so it never reaches the log. Read the screen: the fake
  // returns no scenes for a `tags` criterion, so still-filtered shows 0 cards
  // and dropped shows 40. Deleting `workingFilterFor` reddens this, not the log.
  await waitFor(() => liveCards('video') === 0, 2000);
  const sceneCards = liveCards('video');
  check('S5 and the Scenes listing is still filtered, not refetched unfiltered',
    sceneCards === 0,
    `${sceneCards} video card(s) on screen`);
  check('S5 the dropdown names the tag rather than "Custom filter"',
    /VERIFY tag 3/.test(barText()),
    `bar="${barText().slice(0, 100)}"`);

  // ── S6  a studio does the same, and a gallery goes elsewhere ──
  // A gallery lands on Images, not Scenes, so a hard-coded destination would
  // be right for two sections and wrong for this one.
  await goto('galleries');
  await waitFor(() => has('gallery-2'));

  // ── S6a  the gallery card's second line ─────────────────
  // Studio when there is one, folder otherwise. Gallery 1 has both and gallery
  // 3 has no studio, so "studio wins" and the fallback are both decidable;
  // every value is VERIFY-prefixed, so the wrong field cannot pass.
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
  // Same `.at(-1)` as S5, for the same reason.
  const imgReqs = afterGallery.filter(r => 'image_filter' in r);
  const lastImg = imgReqs[imgReqs.length - 1];
  check('S6 activating a gallery switches to Images',
    railActive() === 'Images', `rail says ${railActive()}`);
  check('S6 the criterion reached the wire',
    !!lastImg && lastImg.image_filter?.galleries?.value?.[0] === '2',
    `${imgReqs.length} image listing(s); last image_filter=${JSON.stringify(lastImg?.image_filter ?? null)}`);
  // The gallery half of S5's screen check: the fake returns nothing for a
  // `galleries` criterion, so a filtered Images section is empty on screen.
  await waitFor(() => liveCards('image') === 0, 2000);
  const imgCards = liveCards('image');
  check('S6 and Images is still filtered to that gallery',
    imgCards === 0, `${imgCards} image card(s) on screen`);

  // ── S6b  Back returns to the gallery card that was opened ──
  // Not the first card, where the grid's own autofocus lands when the restore
  // fails. Assert against document.activeElement and a connected element:
  // `getCurrentFocusId` can name a card that unmounted.
  await pressBack();
  const galleryCardFocused = () => {
    const el = registry.get('gallery-2')?.el;
    return !!el && document.contains(el) && document.activeElement === el;
  };
  const tGallery = Date.now();
  const backToGallery = await waitFor(
    () => railActive() === 'Galleries' && galleryCardFocused(), 8000);
  check('S6b Back returns to the gallery that was opened, not the first card',
    backToGallery,
    `rail ${railActive()}, focus ${focusedId() ?? '<none>'}, active `
      + `${document.activeElement?.className || document.activeElement?.tagName}, `
      + `${Date.now() - tGallery} ms`);

  // ── S7  Back out of a filtered Scenes returns to Tags ───
  // Not to unfiltered Scenes and not to the exit prompt. The prompt is the
  // specific wrong answer: a check reading only "the rail says Tags" would also
  // pass if Back opened the dialog and the dialog's own Back closed it.
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
  // The restore is a retry loop (focusByIdWhenReady), so wait rather than sleep
  // a guessed interval.
  const restored = await waitFor(() => focusedId() === 'tag-3', 3000);
  check('S7 focus is back on the tag that was pressed', restored, `focus: ${focusedId()}`);

  // ── S7b  a card from a later page comes back too ─────────
  // The arriving listing fetches page 1 only, so after scrolling the restore
  // has to ask for the missing pages (utils/focus.js) or it lands on the first
  // card. Tags opens as a List, so match either mode's label: the claim is
  // about paging and the restore, not the layout.
  const tagGrid = () => [...document.querySelectorAll('[role="grid"]')]
    .find(g => /^tags? (grid|list)$/i.test(g.getAttribute('aria-label') || ''));
  const tagScroller = () => tagGrid()?.parentElement;
  const firstPage = liveCards('tag');
  if (tagScroller()) tagScroller().scrollTop = tagScroller().scrollHeight;
  const secondPage = await waitFor(() => liveCards('tag') > firstPage, 6000);
  check('S7b scrolling the Tags listing loads a second page',
    secondPage, `${firstPage} → ${liveCards('tag')} mounted tag card(s)`);

  const pageTwoLive = () => {
    const el = registry.get('tag-45')?.el;
    return !!el && document.contains(el);
  };
  const pageTwoReady = await waitFor(pageTwoLive, 4000);
  check('S7b tag-45 is one of the newly loaded rows', pageTwoReady);
  if (pageTwoReady) {
    focus('tag-45');
    await sleep(120);
    await tapEnter();
    await sleep(600);
    check('S7b activating it switches to Scenes',
      railActive() === 'Scenes', `rail says ${railActive()}`);

    // The restore's requests distinguish "paged forward" from "the card was on
    // page 1": the arriving grid asks for page 1, so page 2 means it paged.
    await clearLogs();
    const tTag = Date.now();
    await pressBack();
    const pageTwoFocused = await waitFor(() => {
      const el = registry.get('tag-45')?.el;
      return railActive() === 'Tags'
        && !!el && document.contains(el) && document.activeElement === el;
    }, 9000);
    check('S7b Back returns to the card from the second page, not the first',
      pageTwoFocused,
      `rail ${railActive()}, focus ${focusedId() ?? '<none>'}, ${Date.now() - tTag} ms`);
    const tagReqs = (await getJSON('/requests')).filter(r => 'tag_filter' in r);
    check('S7b …which the remounted listing reached by paging forward',
      tagReqs.some(r => Number(r.page) >= 2),
      `pages ${tagReqs.map(r => r.page).join(',') || '(none)'}`);
  }

  // ── S8  the filter is dropped on the way out ────────────
  // A surviving scene filter would leave Tags carrying a criterion for a
  // listing it does not show, and the next activation would have to displace it.
  await goto('scenes');
  check('S8 Scenes is unfiltered after backing out',
    !/VERIFY tag 3/.test(barText()),
    `bar="${barText().slice(0, 100)}"`);
  // The complement of S5's screen check: the filter survives an arrival but
  // not a departure. A build that never cleared it would pass everything else
  // here and show an empty Scenes forever.
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
  // The fake serves distinct `/image/n/thumb.png` and `/image/n/full.png`, so
  // a viewer wired to the card's own path would fail rather than look right.
  const img = viewer.querySelector('img');
  check('S10 the viewer shows paths.image, not the thumbnail',
    !!img && /\/image\/1\/full\.png/.test(img.getAttribute('src')),
    `src=${img?.getAttribute('src') ?? '(no img)'}`);
  check('S10 and the thumbnail is not what it opened',
    !!img && !/\/image\/1\/thumb\.png/.test(img.getAttribute('src')),
    'thumb and full are distinct routes on the fake');

  // ── S10b  the info panel is reachable, and asks once ────
  // The picture holds focus after opening and the header button is the only
  // D-pad route in; a `nextId` at an unregistered id would strand the panel,
  // and this app has no pointer.
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
  // The header buttons are children of the focusable surface, so their Enter
  // bubbles into its zoom handler. The footer's level readout is the observable
  // and it must stay blank; a zoom here also turns the next arrows into pan.
  const zoomLabel = () => document.querySelector('[class*="zoomLevel"]')?.textContent ?? '';
  check('S10b …and that press does not also zoom the picture',
    zoomLabel() === '', zoomLabel() || 'no zoom');
  // `visual_files` is the union field Image carries; `files` does not exist,
  // but the fake answers either. Only the query text shows the difference.
  check('S10b the query asks for visual_files, not the invalid `files`',
    info1.length === 1 && info1[0].query.includes('visual_files'),
    info1.length ? info1[0].query.replace(/\s+/g, ' ').slice(0, 120) : '(no fetch)');
  check('S10b the panel shows the metadata, formatted rather than raw',
    /VERIFY image studio 1/.test(panelText())
      && /4000×3000/.test(panelText())
      && /5 MiB/.test(panelText()),
    panelText().replace(/\s+/g, ' ').slice(0, 140));
  // 8 tags / 7 performers / 6 galleries: caps keep the panel from becoming a
  // wall of text at 1080p.
  check('S10b long lists are capped with a +N count',
    /\+2/.test(panelText()) && /\+1/.test(panelText()),
    panelText().replace(/\s+/g, ' ').slice(0, 160));
  // The panel is read-only and the app is D-pad-only: a focusable inside it
  // would be an invisible stop with nothing to press it for.
  const insidePanel = [...registry.entries()]
    .filter(([, e]) => e.el && infoPanel()?.contains(e.el))
    .map(([id]) => id);
  check('S10b the panel adds no focus stops of its own',
    insidePanel.length === 0, `registered inside: ${insidePanel.join(', ') || '(none)'}`);

  // ── S10c  Back peels one layer at a time ────────────────
  // One Back must not close both: the viewer's own Back must stay reachable
  // while the panel is open.
  await pressBack();
  const panelClosed = await waitFor(() => !infoPanel(), 2000);
  check('S10c Back closes the panel, not the viewer',
    panelClosed && !!document.querySelector('[role="dialog"][aria-modal="true"]'),
    panelClosed
      ? (document.querySelector('[role="dialog"][aria-modal="true"]')
        ? 'panel closed, viewer still open' : 'viewer closed too')
      : 'panel still open');

  // Reopening the same image is a cache hit; only the fake's fetch log can tell
  // a cached answer from a fresh one.
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
  // Browsing with the panel closed is free, a second image asks once more, and
  // stepping back is a cache hit. Read from the log: the screen cannot tell.
  await press('ArrowRight');            // image 1 → 2
  await press('ArrowUp');
  await tapEnter();
  await waitFor(() => /VERIFY image studio 2/.test(panelText()), 4000);
  const info2 = await imageInfoFetches();
  check('S11b opening a second image asks once for that image',
    info2.length === 2 && info2[1].id === '2',
    `${info2.length} fetch(es): ${JSON.stringify(info2.map(f => f.id))}`);

  // The Info button holds focus here. Arrows belong to the D-pad, so Left
  // moves the ring to the Slideshow button rather than stepping the picture
  // behind it, which read as Info changing the image.
  const beforeLeft = titleOf();
  await press('ArrowLeft');
  check('S11b Left from Info moves focus to the Slideshow button',
    focusedId() === 'image-viewer-play' && titleOf() === beforeLeft && !!infoPanel(),
    `focus: ${focusedId()}; "${beforeLeft}" → "${titleOf()}"; panel=${!!infoPanel()}`);
  check('S11b the header action is labelled Slideshow, not Play',
    (registry.get('image-viewer-play')?.el?.textContent || '').trim() === 'Slideshow',
    JSON.stringify(registry.get('image-viewer-play')?.el?.textContent || ''));

  // Arrows belong to the D-pad while a header button holds focus, so browse from
  // the picture: Down returns the ring to the surface, where the arrows step
  // again. Both targets are cached, so this must add no fetch.
  await press('ArrowDown');
  await press('ArrowLeft');             // image 2 → 1, panel stays open
  const steppedWithPanel = await waitFor(
    () => /image 1\b/.test(titleOf()) && /VERIFY image studio 1/.test(panelText()),
    3000,
  );
  check('S11b with the picture focused, the arrows still browse under the panel',
    steppedWithPanel && focusedId() === 'image-viewer' && !!infoPanel(),
    `"${titleOf()}"; focus: ${focusedId()}; panel=${!!infoPanel()}`);
  await press('ArrowRight');            // back to image 2
  await waitFor(
    () => /image 2\b/.test(titleOf()) && /VERIFY image studio 2/.test(panelText()),
    3000,
  );

  // With the panel closed the button runs the slideshow. The footer countdown
  // is the observable; a second press stops it without advancing the picture.
  await pressBack();
  await waitFor(() => !infoPanel(), 2000);
  await press('ArrowUp');               // surface → Info
  await press('ArrowLeft');             // Info → Slideshow
  await tapEnter();
  const countdown = () => (document.querySelector('[class*="nextIn"]')?.textContent || '');
  const playLabel = () => (registry.get('image-viewer-play')?.el?.textContent || '').trim();
  const counting = await waitFor(() => /\d+s/.test(countdown()), 2000);
  check('S11b Slideshow starts a countdown to the next picture',
    counting && /Next in/.test(countdown()), countdown() || '(no countdown)');
  check('S11b …and the button says Stop slideshow while it runs',
    playLabel() === 'Stop slideshow', playLabel());
  await tapEnter();
  const countGone = await waitFor(
    () => !document.querySelector('[class*="nextIn"]'), 2000,
  );
  check('S11b …and pressing it again stops the countdown, on the same picture',
    countGone && /image 2\b/.test(titleOf()) && playLabel() === 'Slideshow',
    `"${titleOf()}"; label "${playLabel()}"`);

  await press('ArrowDown');             // back to the picture
  await press('ArrowLeft');             // image 2 → 1
  await press('ArrowUp');
  await tapEnter();
  await waitFor(() => /VERIFY image studio 1/.test(panelText()), 3000);
  const info2b = await imageInfoFetches();
  check('S11b stepping back to a seen image is a cache hit',
    info2b.length === 2,
    `${info2b.length} fetch(es): ${JSON.stringify(info2b.map(f => f.id))}`);
  await pressBack();
  await waitFor(() => !infoPanel(), 2000);

  // ── S11b  the open panel does not stop the show ─────────
  // The timer and its countdown run with the panel up, so the panel is a readout
  // of the picture on screen and follows each step.
  await press('ArrowUp');               // surface → Info
  await tapEnter();
  await waitFor(() => !!infoPanel(), 2000);
  await press('ArrowLeft');             // Info → Slideshow
  check('S11b Left from Info reaches Slideshow with the panel open',
    focusedId() === 'image-viewer-play' && !!infoPanel(),
    `focus: ${focusedId()}; panel=${!!infoPanel()}`);
  const beforeSlide = titleOf();
  await tapEnter();
  const countingOpen = await waitFor(
    () => !!infoPanel() && /\d+s/.test(countdown()), 2000,
  );
  check('S11b Slideshow starts with the panel open and leaves it open',
    countingOpen, `panel=${!!infoPanel()}; ${countdown() || '(no countdown)'}`);

  // The advance is the claim. The next picture was preloaded, so this is also
  // where the cached load could land before the reset and leave a spinner over
  // an invisible picture for good.
  const advanced = await waitFor(
    () => titleOf() !== beforeSlide && /VERIFY image studio 2/.test(panelText()),
    9000,
  );
  const stepImg = viewer.querySelector('img');
  check('S11b with the panel open, the picture still steps on the timer',
    advanced,
    `"${beforeSlide}" → "${titleOf()}"; panel="${panelText().replace(/\s+/g, ' ').slice(0, 60)}"`);
  check('S11b the picture it steps to is drawn, not left behind a spinner',
    !!stepImg && /imageLoaded/.test(stepImg.className)
      && !document.querySelector('[class*="spinner"]'),
    `class="${stepImg?.className || '(no img)'}"`);

  // Stop the show and hand S11c the first picture with the panel closed.
  await tapEnter();
  await waitFor(() => !document.querySelector('[class*="nextIn"]'), 2000);
  await press('ArrowDown');             // Slideshow → picture
  await press('ArrowLeft');             // image 2 → 1
  await waitFor(() => /image 1\b/.test(titleOf()), 2000);
  await pressBack();                    // close the panel
  await waitFor(() => !infoPanel(), 2000);
  check('S11b the picture has focus again for the next case',
    focusedId() === 'image-viewer', focusedId());

  // ── S11c  a slow answer cannot land on the image stepped to ──
  // Open the panel on image 3, return to the picture and step to 4 while 3's
  // request is in flight. The fixture names the studio after the requested id;
  // sampling before 4's answer arrives is what lets this fail.
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
  // A cached failure would look like a working panel the second time, same
  // message, no request, so the fetch count distinguishes them.
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

  // ── S11f  a zoomed picture pans the way the press points ──
  // The fixture serves a picture larger than the stage for `full.png`, so a 2x
  // zoom genuinely overflows and the clamp cannot hide the step. The press
  // moves the window, not the picture: Right reveals the right side.
  const imgEl = () => viewer.querySelector('img');
  await waitFor(() => !!imgEl() && imgEl().complete && imgEl().naturalWidth > 0, 3000);
  await tapEnter();                     // 1x → 2x
  // The CSSOM collapses `translate(x, 0px)` to `translate(x)`, so the Y part
  // is optional in what is read back.
  const panOf = () => {
    const m = /translate\((-?[\d.]+)px(?:, (-?[\d.]+)px)?\)/
      .exec(imgEl()?.style.transform || '');
    return m ? { x: Number(m[1]), y: Number(m[2] ?? 0) } : null;
  };
  const picSize = () => ({
    w: imgEl()?.offsetWidth || 0, h: imgEl()?.offsetHeight || 0,
  });
  const p0 = panOf();
  await press('ArrowRight');
  const p1 = panOf();
  check('S11f Right reveals the right side of the picture',
    !!p0 && !!p1 && p1.x < p0.x && Math.abs(p1.x - p0.x) >= picSize().w * 0.1,
    `${JSON.stringify(p1)} from ${JSON.stringify(p0)}, ${picSize().w}x${picSize().h}; `
      + `transform="${imgEl()?.style.transform}"`);
  await press('ArrowDown');
  const p2 = panOf();
  check('S11f Down reveals the lower part',
    !!p1 && !!p2 && p2.y < p1.y && Math.abs(p2.y - p1.y) >= picSize().h * 0.1,
    `${JSON.stringify(p2)} from ${JSON.stringify(p1)}, ${picSize().w}x${picSize().h}`);
  check('S11f the zoom readout follows the zoom', zoomLabel() === '2×', zoomLabel());

  await pressBack();                    // 2x → 1x, not close
  check('S11f Back resets the zoom before it closes the viewer',
    !!document.querySelector('[role="dialog"][aria-modal="true"]') && zoomLabel() === '',
    `open=${!!document.querySelector('[role="dialog"][aria-modal="true"]')}; zoom="${zoomLabel()}"`);

  // ── S12  Back closes it and returns focus to the card ───
  await pressBack();
  check('S12 Back closes the viewer',
    !document.querySelector('[role="dialog"][aria-modal="true"]'),
    document.querySelector('[role="dialog"]') ? 'still open' : 'closed');
  const backFocus = await waitFor(() => focusedId() === 'image-1', 2000);
  check('S12 focus returns to the card', backFocus, `focus: ${focusedId()}`);

  // ── S12a  an untitled image shows its file's stem ───────
  // Every tenth fixture row has no title and a `visual_files` basename, so the
  // card must read `VERIFY_stem_10`: the field has to survive the query, the
  // normaliser and the card.
  const card10 = registry.get('image-10')?.el;
  check('S12a an untitled image card shows its file stem',
    !!card10 && /VERIFY_stem_10/.test(card10.textContent || ''),
    card10 ? card10.textContent.replace(/\s+/g, ' ').slice(0, 80) : 'card not mounted');

  await tapEnter();                     // reopen from the focused image-1 card
  await waitFor(() => !!document.querySelector('[role="dialog"][aria-modal="true"]'), 2000);
  for (let i = 0; i < 9; i += 1) await press('ArrowRight');   // 1 → 10
  const stemTitle = document.querySelector('[role="dialog"][aria-modal="true"] h2')?.textContent || '';
  check('S12a …and the viewer header agrees',
    stemTitle === 'VERIFY_stem_10', `"${stemTitle}"`);
  for (let i = 0; i < 9; i += 1) await press('ArrowLeft');    // back to image 1
  await pressBack();
  await waitFor(() => focusedId() === 'image-1', 2000);

  // ── S12b  Back returns to the picture the viewer is on ──
  // Stepping from image 1 to 3 and backing out once landed on image 1, the card
  // the viewer opened from; the last image viewed is what should take focus.
  const liveTitle = () =>
    document.querySelector('[role="dialog"][aria-modal="true"] h2')?.textContent || '';
  await tapEnter();                     // reopen from the focused image-1 card
  await waitFor(() => !!document.querySelector('[role="dialog"][aria-modal="true"]'), 2000);
  await press('ArrowRight');            // 1 → 2
  await press('ArrowRight');            // 2 → 3
  const steppedTo = liveTitle();
  await pressBack();
  const lastViewed = await waitFor(() => {
    const el = registry.get('image-3')?.el;
    return !!el && document.contains(el) && document.activeElement === el;
  }, 3000);
  check('S12b Back returns to the last image viewed, not the one it opened on',
    lastViewed && /image 3\b/.test(steppedTo),
    `viewer showed "${steppedTo}"; focus ${focusedId() ?? '<none>'}`);

  // ── S15  columns are per section, and remembered ─────────
  // The count used to be shared by every tab, laying a 3:4 performer card out
  // at Scenes' 4 columns. It is now per-tab and persisted: Performers defaults
  // to 6, everything else to 4, and a change is remembered for that tab only.
  // Assert through the rendered `grid-template-columns`, not localStorage;
  // persistence is asserted separately because rendering the right value but
  // forgetting it on the next launch is a bug settings.js has shipped before.
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

  // A different section keeps its own default: the shared `controls` object
  // used to carry the count across a tab switch.
  await goto('scenes');
  await waitFor(() => has('video-1'));
  await sleep(300);
  check('S15e Scenes still renders its own four columns', gridCols() === 4,
    `rendered ${gridCols()} columns`);

  // …and coming back restores Performers' count, not its default or Scenes'.
  await goto('performers');
  await waitFor(() => has('performer-1'));
  await sleep(300);
  check('S15f Performers reopens at the remembered count', gridCols() === 5,
    `rendered ${gridCols()} columns`);

  // Restore the default so a re-run starts clean; storage is per-driver, but
  // leave the tab as S14 expects to find it.
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
