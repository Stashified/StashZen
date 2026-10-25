/**
 * Headless verification driver for PerformerDetailPage's profile fields.
 *
 * Mounts the real component and hooks, with the real service layer pointed at
 * the fake GraphQL endpoint on the same origin: query text, `runQuery`,
 * `loadPerformerDetail` and the normaliser are shipped code; only the server is
 * a stand-in.
 *
 * The fixture makes the checks real:
 *   • The card says FEMALE and the detail answer NON_BINARY, so card-first
 *     paint and the adopted server value are distinguishable.
 *   • The card is unrated and unfavourited while the answer says 75 and
 *     favourite, so the write must start from Stash's value.
 *   • `career_length` is nonsense ("99 years") while the bounds are real, so a
 *     formatter preferring the wrong field is visible.
 *   • Two URLs share a host and there are four hosts, so a chip-per-URL repeats
 *     a label, a host-only chip cannot echo the raw string, and the 3-chip cap
 *     plus "+1" is visible.
 *   • Every string carries VERIFY, so no fact check passes on incidental text.
 *   • The fake logs the operation, id, query text and update inputs, so "one
 *     narrow query", "the deprecated `url` is gone" and "the write carried the
 *     right value" are asserted on the wire.
 *
 * It cannot tell you how the hero reads on a real panel or whether TV overscan
 * clips a wrapping chip; that is the TV pass.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import PerformerDetailPage from '../../src/pages/PerformerDetailPage.jsx';
import { useKeyHandler } from '../../src/hooks/useKeyHandler.js';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const api = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});
const getJSON = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();
const setMode = (key, value) => api('/mode', { [key]: value });
const clearLogs = () => api('/clear');
// Enter on whatever was just focused — the keydown a remote sends, through the
// real useFocusable handler.
function press(key, keyCode) {
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* still settling */ }
    await sleep(50);
  }
  return false;
}

async function waitForAsync(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch { /* still settling */ }
    await sleep(50);
  }
  return false;
}

// The card the user pressed Enter on: its gender, rating and favourite are the
// listing's and deliberately disagree with the detail answer, so the adoption
// is visible. "Unrated" is not a mistake — the listing carries `rating100` as a
// display string and the page must not write from it.
const CARD = {
  id: '8701',
  name: 'VERIFY performer detail harness',
  disambiguation: 'VERIFY disambiguation',
  image_path: null,
  scene_count: 4,
  favorite: false,
  rating: null,
  country: 'US',
  gender: 'FEMALE',
  birthdate: '1990-01-01',
  // 182 cm is 5 ft 11.65 in: rounding only the inch remainder prints 5′12″.
  // The card carries the height (the profile query does not) for the hero.
  height_cm: 182,
  details: 'VERIFY bio. '.repeat(40),
};
const cardWith = (patch) => ({ ...CARD, ...patch });

function Harness({ card }) {
  // App.jsx owns the global key handler in production; without it nothing is
  // focusable.
  useKeyHandler({ onBack: () => {} });
  return (
    <PerformerDetailPage
      performer={card}
      onBack={() => {}}
      onVideoSelect={() => {}}
      previewMuted={false}
      onMuteToggle={() => {}}
    />
  );
}

const root = createRoot(document.getElementById('root'));
const mount = (card) => root.render(<Harness key={card.id} card={card} />);

// ── Selectors ───────────────────────────────────────────────
const header = () => document.querySelector('header');
const genderEl = (label) => document.querySelector(`[aria-label="Gender: ${label}"]`);
const aliasGroup = () => document.querySelector('[role="group"][aria-label="Also known as"]');
const profileGroup = () => document.querySelector('[role="group"][aria-label="Performer profile"]');
const linksGroup = () => document.querySelector('[role="group"][aria-label="Links"]');
const tagsGroup = () => document.querySelector('[role="group"][aria-label="Performer tags"]');
const actionsGroup = () => document.querySelector('[role="group"][aria-label="Performer actions"]');
const ratingGroup = () => document.querySelector('[role="group"][aria-label^="Rating, "]');
const ratingStars = () =>
  Number((ratingGroup()?.getAttribute('aria-label') || '').match(/Rating, (\d+) of 10/)?.[1] ?? -1);
const favoriteStar = () => document.querySelector('[aria-label="Favorite"]');
const favoriteButton = () => [...(actionsGroup()?.querySelectorAll('button') || [])]
  .find(b => b.textContent.includes('Favourite'));
const detailFetches = async () => (await getJSON('/performerfetches'));
const updateFetches = async () => (await getJSON('/performerupdates'));
const graphqlCalls = async () => (await getJSON('/graphqlcalls'));

// Registry keys inside `el` — the honest signal for "did this block add a
// D-pad stop", because a plain button never wired through useFocusable is
// unreachable from a remote.
const idsInside = (el) => (el ? [...registry.entries()]
  .filter(([, entry]) => entry.el && el.contains(entry.el))
  .map(([id]) => id) : []);

const uncaught = [];
window.addEventListener('error', (e) => uncaught.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => {
  uncaught.push(String(e.reason?.message || e.reason));
});

async function finish() {
  await fetch(`http://127.0.0.1:${PORT}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch(`http://127.0.0.1:${PORT}/done`, { method: 'POST' });
}

// ── The run ─────────────────────────────────────────────────
async function run() {
  setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });
  await clearLogs();
  await setMode('performerDetail', 'slow');

  // ── P0: the card paints while the detail query is still in flight ──
  mount(CARD);
  await sleep(150);

  check('P0 the card paints before the profile query answers',
    document.body.textContent.includes(CARD.name) && document.body.textContent.includes('4 scenes'),
    `name=${document.body.textContent.includes(CARD.name)} scenes=${document.body.textContent.includes('4 scenes')}`);
  check('P0 ...including the card\'s gender',
    !!genderEl('Female'), `gender=${genderEl('Female') ? 'Female' : 'missing'}`);
  check('P0 ...and no profile field is shown yet',
    !document.body.textContent.includes('VERIFY profile alias'),
    `alias text=${document.body.textContent.includes('VERIFY profile alias')}`);

  // ── P1: the fetched profile lands on top of the card ─────────
  const loaded = await waitFor(() => !!aliasGroup(), 4000);
  check('P1 the aliases arrive from the detail query', loaded && !!aliasGroup(),
    `group=${!!aliasGroup()}`);
  check('P1 the server\'s gender replaces the card\'s, humanised',
    !!genderEl('Non-binary') && !document.body.textContent.includes('NON_BINARY'),
    `Non-binary=${!!genderEl('Non-binary')} raw=${document.body.textContent.includes('NON_BINARY')}`);

  const aliasText = aliasGroup()?.textContent || '';
  check('P1 both aliases are listed',
    aliasText.includes('VERIFY profile alias one') && aliasText.includes('VERIFY profile alias two'),
    `group reads "${aliasText.trim()}"`);

  const factText = profileGroup()?.textContent || '';
  check('P1 the career range comes from the bounds, not career_length',
    factText.includes('Career 1999–2011') && !factText.includes('99 years'),
    `facts read "${factText.trim()}"`);
  check('P1 measurements are shown',
    factText.includes('VERIFY 34-24-35'), `facts read "${factText.trim()}"`);
  check('P1 the height carries whole inches: 182 cm is 6′0″, not 5′12″',
    (document.body.textContent || '').includes('182 cm · 6′0″'),
    `height text: ${((document.body.textContent || '').match(/\d+ cm · \S+/) || ['<none>'])[0]}`);
  check('P1 tattoos are shown',
    factText.includes('VERIFY tattoo: anchor'), `facts read "${factText.trim()}"`);

  // ── The enrichment fields (item 4) ──────────────────────
  check('P1 the profile facts carry every enriched field',
    ['Ethnicity VERIFY ethnicity', 'Hair VERIFY hair', 'Eyes VERIFY eyes',
      'Weight 61', 'Piercings VERIFY piercings', 'Fake tits VERIFY fake']
      .every(s => factText.includes(s)),
    `facts read "${factText.trim()}"`);
  check('P1 no empty fact label leaks (the fixture has no death date)',
    !factText.includes('Died') && !factText.includes('undefined')
      && !factText.includes('null'),
    `facts read "${factText.trim()}"`);

  const metaText = header()?.querySelector('[class*="metaRow"]')?.textContent || '';
  check('P1 the engagement counts render as words, not raw numbers',
    metaText.includes('7 likes') && metaText.includes('11 images') && metaText.includes('2 galleries'),
    `meta reads "${metaText.trim()}"`);

  // ── Links (item 5) ──────────────────────────────────────
  // Two of the five URLs share a host: a chip-per-URL prints "profile-8701"
  // twice. Three distinct hosts survive the cap and the fourth becomes "+1".
  const linkChips = [...(linksGroup()?.querySelectorAll('[aria-label^="Website:"]') || [])];
  const linkHosts = linkChips.map(c => c.textContent.trim());
  check('P1 one link chip per host, capped at three, with a count for the rest',
    linkChips.length === 3 && new Set(linkHosts).size === 3
      && linkHosts.includes('profile-8701.verify.invalid')
      && linkHosts.includes('second-8701.verify.invalid')
      && linkHosts.includes('third-8701.verify.invalid'),
    `chips: ${linkHosts.join(' | ')}`);
  check('P1 the omitted host is counted, not dropped silently',
    (linksGroup()?.textContent || '').includes('+1')
      && !linkHosts.includes('fourth-8701.verify.invalid'),
    `group reads "${(linksGroup()?.textContent || '').trim()}"`);
  check('P1 a link chip shows the host while its label keeps the full URL',
    linkChips[0]?.textContent.trim() === 'profile-8701.verify.invalid'
      && linkChips[0]?.getAttribute('aria-label')
        === 'Website: https://profile-8701.verify.invalid/about'
      && !(linksGroup()?.textContent || '').includes('https://'),
    `label="${linkChips[0]?.getAttribute('aria-label')}" text="${linkChips[0]?.textContent}"`);

  // ── Tags (item 4) ───────────────────────────────────────
  const tagText = tagsGroup()?.textContent || '';
  check('P1 the performer tags are listed',
    tagText.includes('VERIFY performer tag one') && tagText.includes('VERIFY performer tag two')
      && !tagText.includes('+'),
    `tags read "${tagText.trim()}"`);

  // ── The write authority (item 6) ────────────────────────
  // The card was unrated and unfavourited; the detail answer is 75 and
  // favourite, so both readings are adopted values. The profile renders the
  // aliases, then an effect copies `rating100`/`favorite` into edit state one
  // commit later, so reading straight after the alias group can catch the
  // card's 0 — a race, not a stale answer.
  await waitFor(() => ratingStars() === 8, 4000);
  check('P1 the rating and favourite come from the detail answer',
    ratingStars() === 8 && !!favoriteStar()
      && favoriteButton()?.getAttribute('aria-pressed') === 'true',
    `stars=${ratingStars()} titleStar=${!!favoriteStar()} `
    + `pressed=${favoriteButton()?.getAttribute('aria-pressed')}`);

  const fetches = await detailFetches();
  check('P1 exactly one detail query, for the card that was opened',
    fetches.length === 1 && fetches[0].id === '8701',
    `${fetches.length} fetch(es): ${JSON.stringify(fetches.map(f => f.id))}`);
  const q = fetches[0]?.query || '';
  const wanted = ['gender', 'alias_list', 'career_start', 'career_end', 'career_length',
    'tattoos', 'measurements', 'urls', 'ethnicity', 'hair_color', 'eye_color',
    'weight', 'piercings', 'fake_tits', 'death_date', 'o_counter', 'image_count',
    'gallery_count', 'rating100', 'favorite', 'tags'];
  const avoided = ['details', 'stash_ids', 'scene_count', 'image_path', 'country',
    'birthdate', 'height_cm'];
  check('P1 the query is the profile selection, enriched and still narrow',
    wanted.every(f => q.includes(f)) && avoided.every(f => !q.includes(f)),
    `missing=${wanted.filter(f => !q.includes(f))}; leaked=${avoided.filter(f => q.includes(f))}`);
  // `url` is a substring of `urls`, so a plain includes() could never fail; the
  // word boundary makes "the deprecated field is gone" refutable.
  check('P1 the deprecated `url` field is not asked for',
    !/(^|[^A-Za-z0-9_])url([^A-Za-z0-9_]|$)/.test(q),
    `urls present=${q.includes('urls')}`);
  const calls = await graphqlCalls();
  check('P1 opening the detail did not fetch the 40-row listing',
    calls.includes('FindPerformerDetail') && !calls.includes('FindPerformers'),
    `calls: ${calls.join(', ')}`);

  // ── P2: the wrapping profile block fits the hero ────────────
  //
  // Every block is capped in code — an uncapped bio or tag list would blow past
  // the bound by hundreds of pixels, while the capped rows stay within ~four
  // extra chip rows.
  const h = header();
  const poster = h?.querySelector('img') || h?.querySelector('[class*="imageFallback"]');
  const heroH = h?.getBoundingClientRect().height || 0;
  const posterH = poster?.getBoundingClientRect().height || 0;
  check('P2 the hero is bounded with every field populated',
    posterH > 0 && heroH <= posterH + 200 + 1,
    `hero=${Math.round(heroH)}px poster=${Math.round(posterH)}px bound=${Math.round(posterH + 200)}px`);
  const bio = [...(h?.querySelectorAll('p') || [])].find(p => (p.textContent || '').startsWith('VERIFY bio.'));
  check('P2 the long bio is clamped rather than pushing the grid down',
    !!bio && bio.clientHeight > 0 && bio.scrollHeight > bio.clientHeight,
    bio ? `client=${bio.clientHeight}px scroll=${bio.scrollHeight}px` : 'no bio');

  // ── P3: career_length is the fallback when the bounds are absent ──
  await setMode('performerDetail', 'length-only');
  mount(cardWith({ id: '8704' }));
  const lengthLoaded = await waitFor(
    () => (profileGroup()?.textContent || '').includes('Career 12 years'), 4000);
  const lengthFacts = profileGroup()?.textContent || '';
  check('P3 with no bounds, career_length is shown instead',
    lengthLoaded && !lengthFacts.includes('1999'), `facts read "${lengthFacts.trim()}"`);
  const lengthFetches = (await detailFetches()).filter(f => f.id === '8704');
  check('P3 ...and it was the detail answer, not the card',
    lengthFetches.length === 1, `${lengthFetches.length} fetch(es) for 8704`);

  // ── P4: empty fields hide, they do not render empty rows ────
  await setMode('performerDetail', 'sparse');
  mount(cardWith({ id: '8702' }));
  const sparseFetched2 = await waitFor(
    () => (document.body.textContent.includes(CARD.name) && document.querySelector('[aria-label^="Gender:"]')),
    4000);
  // Wait for the sparse answer to be logged and painted — the page shows
  // nothing new, so the fetch log is the settle signal.
  await waitForAsync(
    async () => (await getJSON('/performerfetches')).some(f => f.id === '8702'), 4000);
  await sleep(150);
  const sparseFetch = (await detailFetches()).filter(f => f.id === '8702');
  const hText = header()?.textContent || '';
  const sparseMeta = header()?.querySelector('[class*="metaRow"]')?.textContent || '';
  check('P4 a performer with no profile fields renders no alias, fact, link or tag rows',
    sparseFetched2 && !aliasGroup() && !profileGroup() && !linksGroup() && !tagsGroup(),
    `alias=${!!aliasGroup()} facts=${!!profileGroup()} `
    + `links=${!!linksGroup()} tags=${!!tagsGroup()}`);
  check('P4 ...and no profile words leak into the hero',
    !/Career|Measurements|Tattoos|Ethnicity|Piercings|Fake tits|profile-8701/.test(hText),
    `hero reads "${hText.slice(0, 120)}"`);
  check('P4 zero counts are hidden rather than printed as "0 likes"',
    !sparseMeta.includes('0 likes') && !sparseMeta.includes('0 images')
      && !sparseMeta.includes('0 galleries'),
    `meta reads "${sparseMeta.trim()}"`);
  check('P4 ...while the card identity stays, including its gender',
    hText.includes(CARD.name) && hText.includes('4 scenes') && !!genderEl('Female'),
    `name=${hText.includes(CARD.name)} scenes=${hText.includes('4 scenes')} gender=${!!genderEl('Female')}`);
  // The write controls exist but are seeded empty from the sparse answer; they
  // stay visible because a performer with no profile text is still a row the
  // user may rate.
  check('P4 the write controls are present and seeded empty',
    !!actionsGroup() && ratingStars() === 0
      && favoriteButton()?.getAttribute('aria-pressed') === 'false' && !favoriteStar(),
    `actions=${!!actionsGroup()} stars=${ratingStars()} `
    + `pressed=${favoriteButton()?.getAttribute('aria-pressed')}`);
  check('P4 the null fields were hidden after a real fetch, not because none was made',
    sparseFetch.length === 1, `${sparseFetch.length} fetch(es) for 8702`);

  // ── P5: a failed profile fetch leaves the card on screen ───
  await setMode('performerDetail', 'fail');
  mount(cardWith({ id: '8703' }));
  const warned = await waitFor(
    () => document.body.textContent.includes("Couldn't load profile details"), 4000);
  const failFetches = (await detailFetches()).filter(f => f.id === '8703');
  check('P5 a failed fetch keeps the card and says so',
    warned && document.body.textContent.includes(CARD.name),
    `warning=${warned}`);
  check('P5 ...without an uncaught rejection',
    uncaught.length === 0, uncaught.join(' | '));
  check('P5 ...and the attempt is on the record',
    failFetches.length === 1, `${failFetches.length} fetch(es) for 8703`);

  // ── P6: the chips are inert; the write controls are the only new stops ──
  //
  // The contract is not "Back owns the autofocus": the page's video grid
  // autofocuses its first card and wins that race. What must hold is that the
  // profile block is inert — no chip registered with the D-pad, none carrying a
  // tabindex/button role — and the control row adds exactly its three stops.
  await setMode('performerDetail', 'ok');
  mount(CARD);
  const chipsLoaded = await waitFor(
    () => !!aliasGroup() && !!profileGroup() && !!linksGroup() && !!tagsGroup()
      && !!actionsGroup(), 4000);
  await sleep(200);
  const inertGroups = [aliasGroup(), profileGroup(), linksGroup(), tagsGroup()].filter(Boolean);
  const registeredInert = inertGroups.flatMap(g => idsInside(g));
  const focusableInert = inertGroups.filter(g => g.querySelector('button, a, [tabindex]'));
  const actionIds = idsInside(actionsGroup());
  const expectedActions = ['performer-rating-dec', 'performer-rating-inc', 'performer-favorite'];
  check('P6 the profile, link and tag chips added no D-pad targets',
    chipsLoaded && registeredInert.length === 0 && focusableInert.length === 0,
    `groups=${inertGroups.length} registered=${registeredInert.join(',') || 0} `
    + `focusable=${focusableInert.length}`);
  check('P6 the only new focus stops are the rating stepper and favourite',
    actionIds.length === expectedActions.length
      && expectedActions.every(id => actionIds.includes(id))
      && ![...registry.keys()].some(id => id.startsWith('scene-rating')),
    `actions=[${actionIds.join(',')}] sceneIdsReused=${[...registry.keys()].some(id => id.startsWith('scene-rating'))}`);
  const active = document.activeElement;
  check('P6 initial focus is still the first scene card, not a control',
    !!active && active.tagName === 'BUTTON' && !actionsGroup()?.contains(active)
      && !inertGroups.some(g => g.contains(active)),
    `active=<${active?.tagName?.toLowerCase()}> `
    + `"${(active?.getAttribute('aria-label') || active?.textContent || '').trim().slice(0, 40)}"`);

  // ── P7: rating and favourite are optimistic and roll back ───
  // The stepper works in whole stars; the detail answer is 75, shown as 8. One
  // press up is 90, the value the mutation must carry — the number the server
  // stores, not the rounded star count.
  const focusPress = async (id) => {
    const entry = registry.get(id);
    if (!entry) throw new Error(`focus target ${id} is not registered`);
    entry.el.focus();
    await sleep(50);
    press('Enter', 13);
    await sleep(60);
  };

  await setMode('performerUpdate', 'slow');
  await clearLogs();
  await focusPress('performer-rating-inc');
  check('P7a the rating paints one star up before the server answers',
    ratingStars() === 9, `stars=${ratingStars()}`);
  await waitForAsync(async () => (await updateFetches()).length === 1, 4000);
  // The `slow` arm logs the request, then holds the answer for 1.2 s; waiting
  // it out makes the next press a new write rather than one in flight.
  await sleep(1400);
  const slowRating = await updateFetches();
  check('P7b the write sends the stored 0–100 value, from the server\'s rating',
    slowRating.length === 1
      && slowRating[0].input.id === '8701'
      && slowRating[0].input.rating100 === 90
      && !('favorite' in slowRating[0].input),
    `input=${JSON.stringify(slowRating[0]?.input)}`);
  check('P7c the star survives the server\'s answer',
    ratingStars() === 9, `stars=${ratingStars()}`);

  await setMode('performerUpdate', 'ok');
  await focusPress('performer-rating-dec');
  await waitForAsync(async () => (await updateFetches()).length === 2, 4000);
  await sleep(200);
  const downRating = (await updateFetches())[1];
  check('P7d stepping down sends 80 and keeps focus on the stepper',
    downRating?.input.rating100 === 80 && ratingStars() === 8,
    `input=${JSON.stringify(downRating?.input)} stars=${ratingStars()}`);

  // Favourite: the server has it set, so the first press is the un-set.
  await focusPress('performer-favorite');
  check('P7e favourite toggles optimistically',
    favoriteButton()?.getAttribute('aria-pressed') === 'false' && !favoriteStar(),
    `pressed=${favoriteButton()?.getAttribute('aria-pressed')} star=${!!favoriteStar()}`);
  await waitForAsync(async () => (await updateFetches()).length === 3, 4000);
  await sleep(150);
  const favWrite = (await updateFetches())[2];
  check('P7f the favourite write carries the boolean alone',
    favWrite?.input.id === '8701' && favWrite?.input.favorite === false
      && !('rating100' in (favWrite?.input || {})),
    `input=${JSON.stringify(favWrite?.input)}`);

  // Failure: both edits must return to their previous value and say so.
  await setMode('performerUpdate', 'fail');
  await focusPress('performer-rating-inc');
  const rolledBack = await waitFor(
    () => (document.body.textContent || '').includes('Rating not saved'), 4000);
  check('P7g a failed rating write rolls the star back and explains',
    !!rolledBack && ratingStars() === 8
      && (document.body.textContent || '').includes('simulated performer write failure'),
    `stars=${ratingStars()} notice=${!!rolledBack}`);
  await focusPress('performer-favorite');
  const favBack = await waitFor(
    () => (document.body.textContent || '').includes('Favourite not saved'), 4000);
  check('P7h a failed favourite write rolls the star back and explains',
    !!favBack && favoriteButton()?.getAttribute('aria-pressed') === 'false'
      && !favoriteStar() && uncaught.length === 0,
    `pressed=${favoriteButton()?.getAttribute('aria-pressed')} notice=${!!favBack} uncaught=${uncaught.length}`);
  const writeAttempts = await updateFetches();
  check('P7i every press reached the server exactly once',
    writeAttempts.length === 5,
    `${writeAttempts.length} attempt(s): ${JSON.stringify(writeAttempts.map(w => w.input))}`);

  await finish();
}

run().catch(async (e) => {
  results.push({
    name: 'HARNESS CRASHED',
    pass: false,
    detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
  });
  try { await finish(); } catch { /* nothing left to do */ }
});
