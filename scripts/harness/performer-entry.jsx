/**
 * Headless verification driver for PerformerDetailPage's profile fields.
 *
 * Mounts the real component with the real hooks, and points the real service
 * layer at the fake GraphQL endpoint on the same origin. So the query text,
 * `runQuery`, `loadPerformerDetail` and the normaliser are all the shipped
 * code — only the server is a stand-in.
 *
 * What makes the checks real rather than "something rendered":
 *   • The card says gender FEMALE and the fake detail answer says NON_BINARY,
 *     so the card-first paint and the adopted server value are distinguishable.
 *   • `career_length` is deliberately nonsense ("99 years") while the bounds
 *     are real, so a formatter that prefers the wrong field is visible.
 *   • Every string carries VERIFY, and the URL has a scheme and a path, so a
 *     host-only chip cannot pass by echoing the raw string.
 *   • The fake logs the operation, its id and the query text, so "one narrow
 *     query and no 40-row listing" is asserted on the wire, not inferred.
 *
 * What this cannot tell you: how the hero reads on a real panel, or whether TV
 * overscan clips a wrapping chip. That is the TV pass.
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

// The card the user "pressed Enter on". Its gender is the listing's value, so
// the page paints Female before the detail answer replaces it.
const CARD = {
  id: '8701',
  name: 'VERIFY performer detail harness',
  disambiguation: 'VERIFY disambiguation',
  image_path: null,
  scene_count: 4,
  favorite: true,
  rating: '7.5',
  country: 'US',
  gender: 'FEMALE',
  birthdate: '1990-01-01',
  // 182 cm is 5 ft 11.65 in: rounding only the inch remainder prints 5′12″.
  // The card carries the height (the profile query deliberately does not), so
  // this is the value the hero renders.
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
const websiteEl = () => document.querySelector('[aria-label^="Website:"]');
const detailFetches = async () => (await getJSON('/performerfetches'));
const graphqlCalls = async () => (await getJSON('/graphqlcalls'));

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
  check('P1 the website chip shows the host, not the raw URL',
    !!websiteEl()
      && websiteEl().textContent.includes('profile-8701.verify.invalid')
      && !websiteEl().textContent.includes('https://'),
    `chip reads "${websiteEl()?.textContent}"`);

  const fetches = await detailFetches();
  check('P1 exactly one detail query, for the card that was opened',
    fetches.length === 1 && fetches[0].id === '8701',
    `${fetches.length} fetch(es): ${JSON.stringify(fetches.map(f => f.id))}`);
  const q = fetches[0]?.query || '';
  const wanted = ['gender', 'alias_list', 'career_start', 'career_end', 'career_length',
    'tattoos', 'measurements', 'url'];
  const avoided = ['details', 'stash_ids', 'scene_count', 'image_path', 'rating100',
    'favorite', 'country', 'birthdate', 'height_cm'];
  check('P1 the query is the narrow profile selection',
    wanted.every(f => q.includes(f)) && avoided.every(f => !q.includes(f)),
    `missing=${wanted.filter(f => !q.includes(f))}; leaked=${avoided.filter(f => q.includes(f))}`);
  const calls = await graphqlCalls();
  check('P1 opening the detail did not fetch the 40-row listing',
    calls.includes('FindPerformerDetail') && !calls.includes('FindPerformers'),
    `calls: ${calls.join(', ')}`);

  // ── P2: the wrapping profile block fits the hero ────────────
  const h = header();
  const poster = h?.querySelector('img') || h?.querySelector('[class*="imageFallback"]');
  const heroH = h?.getBoundingClientRect().height || 0;
  const posterH = poster?.getBoundingClientRect().height || 0;
  check('P2 the hero is still poster-sized with every field populated',
    posterH > 0 && heroH <= posterH + 64 + 1,
    `hero=${Math.round(heroH)}px poster=${Math.round(posterH)}px`);

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
  // Wait for the sparse answer to have been logged and painted (the page has
  // nothing new to show, so the fetch log is the settle signal).
  await waitForAsync(
    async () => (await getJSON('/performerfetches')).some(f => f.id === '8702'), 4000);
  await sleep(150);
  const sparseFetch = (await detailFetches()).filter(f => f.id === '8702');
  const hText = header()?.textContent || '';
  check('P4 a performer with no profile fields renders no alias or fact rows',
    sparseFetched2 && !aliasGroup() && !profileGroup(),
    `alias=${!!aliasGroup()} facts=${!!profileGroup()}`);
  check('P4 ...and no profile words leak into the hero',
    !/Career|Measurements|Tattoos|profile-8701/.test(hText),
    `hero reads "${hText.slice(0, 120)}"`);
  check('P4 ...while the card identity stays, including its gender',
    hText.includes(CARD.name) && hText.includes('4 scenes') && !!genderEl('Female'),
    `name=${hText.includes(CARD.name)} scenes=${hText.includes('4 scenes')} gender=${!!genderEl('Female')}`);
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

  // ── P6: the chips added no focus targets ────────────────────
  //
  // The contract is not "Back owns the autofocus": this page also renders the
  // performer's video grid, whose first card autofocuses and wins the race (as
  // it did before this change). What must not change is that the profile block
  // itself is inert — no chip is registered with the D-pad, and none carries a
  // tabindex/button role.
  await setMode('performerDetail', 'ok');
  mount(CARD);
  const chipsLoaded = await waitFor(() => !!aliasGroup() && !!profileGroup(), 4000);
  await sleep(150);
  const groups = [aliasGroup(), profileGroup()].filter(Boolean);
  const registeredInside = [...registry.values()].filter(
    entry => groups.some(g => g.contains(entry.el)));
  const focusableInside = groups.some(g => !!g.querySelector('button, a, [tabindex]'));
  const active = document.activeElement;
  check('P6 the profile chips added no D-pad targets',
    chipsLoaded && registeredInside.length === 0 && !focusableInside,
    `groups=${groups.length} registered=${registeredInside.length} focusable=${focusableInside}`);
  check('P6 initial focus is still the first scene card, not a chip',
    !!active && active.tagName === 'BUTTON' && !groups.some(g => g.contains(active)),
    `active=<${active?.tagName?.toLowerCase()}> `
    + `"${(active?.getAttribute('aria-label') || active?.textContent || '').trim().slice(0, 40)}"`);

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
