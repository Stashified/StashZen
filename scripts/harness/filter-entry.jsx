/**
 * Headless driver for the filter builder (0.9.0 / P2).
 *
 * Mounts the whole `App`, like rail-entry, because the builder is not a
 * component you can hand props to and learn anything from. Its claims are
 * about a *path*: a control in the bar opens it, a criterion is composed in
 * Stash's stored envelope, that envelope becomes the listing's filter, and the
 * server that receives it sees the thing the user asked for. Every step of
 * that is in a different file, and the only place all of them are assembled is
 * the real App talking to a real (fake) endpoint.
 *
 * WHAT F1–F3 AND F7 ACTUALLY PROVE. `scene_filter` in `/requests` is the
 * server's own record of the GraphQL variables it was sent. Asserting on it is
 * therefore an end-to-end claim — builder → stored envelope → `workingFilter`
 * → `translateFilter` → wire — and not a claim about any one of those. A
 * driver that stopped at "the row appeared in the DOM" would pass on a builder
 * that composed a filter Stash rejects.
 *
 * F5 is the one check that exists because of a bug found while writing this
 * file, and it is worth knowing that is why. The builder registers its Back
 * handler on `window` in the capture phase; so does every overlay it opens;
 * capture listeners on one target run in *registration* order, so the
 * builder's — registered at mount, before any picker existed — ran first, and
 * one Back closed the picker and the builder together. `stopPropagation` does
 * not help against a sibling listener on the same target. The control
 * experiment for F5 is to delete `overlayOpenRef` from FilterBuilder and watch
 * it go red; without that, the check is a check on nothing.
 *
 * What this cannot tell you: that any of it looks good, and anything at all
 * about the TV's IME. The search box inside the entity picker is driven here
 * by setting the input's value directly, which is precisely the layer the real
 * remote would have to go through and the harness cannot.
 */

import '../../src/index.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { useSavedFilters } from '../../src/hooks/useSavedFilters.js';
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

async function waitFor(pred, ms = 5000, step = 25) {
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

async function tapEnter() {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await sleep(150);
}

// ── Reading the app ─────────────────────────────────────────
const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"]'));
const dialogNamed = (re) => dialogs().find(d => re.test(d.getAttribute('aria-label') || ''));

const btnByText = (root, text) =>
  Array.from(root?.querySelectorAll('button') ?? [])
    .find(b => b.textContent.trim().startsWith(text));

const rowLabels = (builder) =>
  Array.from(builder.querySelectorAll('[class*="rowLabel"]')).map(e => e.textContent.trim());

const getJson = (p) => fetch(p).then(r => r.json());

// The last FindScenes request the fake saw, which is the one the currently
// displayed listing came from.
async function lastSceneFilter() {
  const reqs = await getJson('/requests');
  const scenes = reqs.filter(r => r.scene_filter !== undefined);
  return scenes.length ? scenes[scenes.length - 1].scene_filter : null;
}

async function clearLog() {
  await fetch('/clear', { method: 'POST', body: '{}' });
}

// ── The run ─────────────────────────────────────────────────
// A probe for `useSavedFilters` itself. The hook is used only by App, and App
// has no saved filter on the Performers tab, so a mode switch that keeps the
// previous mode's rows is invisible unless the read for the new mode fails.
// This mounts the real hook in a second root and switches its mode under a
// failing read — the exact situation the clear-on-mode-change exists for.
let probeState = { mode: null, names: [], error: null };

function SavedFilterProbe({ initialMode, source }) {
  const [mode, setMode] = useState(initialMode);
  const [src, setSrc] = useState(source);
  const { filters, error } = useSavedFilters(mode, src);
  probeState = { mode, source: src, names: filters.map(f => f.name), error: error || null };
  return (
    <>
      <button id="probe-switch-mode" onClick={() => setMode(m => (m === 'scenes' ? 'performers' : 'scenes'))}>
        switch mode
      </button>
      <button id="probe-switch-source" onClick={() => setSrc('probe-h-other')}>
        switch source
      </button>
    </>
  );
}

async function run() {
  // Home is the showroom as of 0.15.0 and carries no controls bar at all, so
  // the filter builder this driver is about now lives on the Scenes tab.
  // Switch there the way a remote does before waiting on the listing.
  //
  // The settle first is load-bearing, not politeness. `nav-home` autoFocuses
  // on a 50 ms timer of its own; this driver used to focus `nav-scenes` the
  // moment the rail existed, then lose the race — the timer pulled focus back
  // to Home before the Enter landed, so Enter re-entered Home and every check
  // below ran against a screen with no controls bar. Waiting past the timer
  // is what makes the next press go where it says it goes.
  await waitFor(() => registry.has('nav-scenes'));
  await sleep(400);
  registry.get('nav-scenes')?.el.focus();
  await sleep(120);
  await tapEnter();
  await sleep(400);
  const onScenes = await waitFor(() => registry.has('video-1'));
  // A precondition stated rather than assumed: every check below is about the
  // filter bar, which only exists on a listing tab. Without this, a driver
  // that failed to leave Home reported "no Build button" — a true sentence
  // about the wrong screen, and the same class of wrong-reason pass this
  // suite has been burned by before.
  check('F0 the driver reached the Scenes tab',
    onScenes && !!registry.get('ctrl-build-filter'),
    `scenes cards=${registry.has('video-1')} build=${!!registry.get('ctrl-build-filter')} `
    + `rail=${document.querySelector('nav[aria-label="Main navigation"] [aria-current="page"]')?.textContent?.trim() ?? '(none)'}`);
  await sleep(300);

  // ── F1  the entry point ─────────────────────────────────
  const buildBtn = btnByText(document, 'Build…');
  check('F1 the controls bar carries a Build action', !!buildBtn,
    buildBtn ? 'found' : 'no button starting with "Build…"');

  if (!buildBtn) return;
  buildBtn.click();
  await sleep(200);

  const builder = dialogNamed(/^Filter scenes/);
  check('F2 opening it mounts a dialog labelled for the tab', !!builder,
    builder ? builder.getAttribute('aria-label') : `dialogs: ${dialogs().map(d => d.getAttribute('aria-label')).join(' | ') || 'none'}`);
  if (!builder) return;

  check('F2b it opens empty and says so', rowLabels(builder).length === 0,
    `${rowLabels(builder).length} rows on open`);

  // ── F3  add a criterion ─────────────────────────────────
  const addBtn = btnByText(builder, '+ Add criterion');
  check('F3 the builder offers an Add criterion action', !!addBtn);
  if (!addBtn) return;
  addBtn.click();
  await sleep(200);

  const picker = dialogNamed(/Add a criterion/);
  check('F3b it opens as a nested dialog', !!picker);
  if (!picker) return;

  // The nested dialog must be a DOM child of the builder, not a portal. If it
  // were portalled it would still be *found* by this query — the assertion has
  // to be on containment, which is also what focusScopeOf depends on.
  check('F3c the nested dialog is a DOM child of the builder, not portalled',
    builder.contains(picker), 'focusScopeOf depends on this');

  const fieldRows = Array.from(picker.querySelectorAll('[class*="pickRow"]'));
  check('F3d the Common tab lists fields', fieldRows.length > 0, `${fieldRows.length} fields`);

  // The tabs must be there and Unavailable must be non-empty, since "all
  // fields" is only an honest claim if the fields it cannot reach are shown.
  const tabs = Array.from(picker.querySelectorAll('[role="tab"]')).map(t => t.textContent.trim());
  check('F3e it offers Common / All fields / Unavailable',
    tabs.join('|') === 'Common|All fields|Unavailable', tabs.join('|'));

  // The Unavailable tab is the whole of the "all fields" claim. The builder
  // reaches every field of SceneFilterType except a handful, and PLAN.md says
  // those are *listed with a reason* rather than hidden — which is only true
  // if this tab has rows in it. Asserted rather than assumed, because a
  // silently empty list would look identical to a filter type with nothing
  // unreachable.
  const offTab = Array.from(picker.querySelectorAll('[role="tab"]'))
    .find(t => t.textContent.trim() === 'Unavailable');
  offTab?.click();
  await sleep(250);
  const offRows = Array.from(picker.querySelectorAll('[class*="pickRow"]'));
  const offDisabled = offRows.filter(r => r.disabled);
  const offReasons = offRows.map(r => (r.querySelector('[class*="pickWhy"]')?.textContent || '').trim());
  check('F3f the Unavailable tab lists unreachable fields', offRows.length > 0,
    `${offRows.length} rows`);
  check('F3g …all of them disabled', offRows.length > 0 && offDisabled.length === offRows.length,
    `${offDisabled.length} of ${offRows.length} disabled`);
  check('F3h …each with a reason rather than only a field name',
    offReasons.length > 0 && offReasons.every(r => r.length > 0),
    `reasons: ${offReasons.join(' | ') || 'none'}`);

  const commonTab = Array.from(picker.querySelectorAll('[role="tab"]'))
    .find(t => t.textContent.trim() === 'Common');
  commonTab?.click();
  await sleep(250);

  // ── F5  Back inside the picker closes only the picker ────
  // Deliberately before anything else is done with the picker: this is the
  // check that the ordering guard exists for.
  await press('Escape');
  await sleep(200);
  check('F5 Back closes the nested picker', !dialogNamed(/Add a criterion/));
  check('F5b …and leaves the builder open behind it', !!dialogNamed(/^Filter scenes/),
    `dialogs now: ${dialogs().map(d => d.getAttribute('aria-label')).join(' | ') || 'none'}`);

  const b2 = dialogNamed(/^Filter scenes/);
  if (!b2) return;

  // ── F4  compose a filter that reaches the wire ───────────
  btnByText(b2, '+ Add criterion').click();
  await sleep(200);
  const p2 = dialogNamed(/Add a criterion/);
  if (!p2) { check('F4 could reopen the field picker', false); return; }

  // "Title" is in SceneFilterType's Common list and takes a plain string, so
  // it exercises the text editor without needing an entity lookup. Focus the
  // row by its registry id — the field picker's rows carry no DOM id and their
  // CSS-module classes are hashed.
  const titleEntry = Array.from(registry.entries())
    .find(([id]) => id.startsWith('fp-title'));
  check('F4 the field picker has a Title row', !!titleEntry,
    `pick rows: ${Array.from(registry.keys()).filter(k => k.startsWith('fp-')).join(', ')}`);
  if (!titleEntry) return;
  titleEntry[1].el.focus();
  await tapEnter();
  await sleep(250);

  const b3 = dialogNamed(/^Filter scenes/);
  check('F4b adding it produces a criterion row', rowLabels(b3).includes('Title'),
    `rows: ${rowLabels(b3).join(', ') || 'none'}`);

  // Fill the value box. The input is inside the row; `useEditableField` puts
  // the focus on the wrapper and the input is where the text goes, so setting
  // the value and dispatching `input` is what a real IME commit ends up doing.
  const valueInput = b3.querySelector('[class*="valueInput"]');
  check('F4c the row carries a value editor', !!valueInput);
  if (!valueInput) return;

  // Drive the modifier dropdown rather than accepting its default. A
  // criterion that is added and never touched is `EQUALS` — whatever the
  // builder's `blankCriterion` happens to pick — so asserting on the default
  // would be asserting on the literal in that function and nothing else. Going
  // through the menu is what exercises the Choice component, the modifier
  // labels and the envelope rewrite that `setModifier` does.
  const modEntry = registry.get('fb-mod-title');
  check('F4c2 the row carries a modifier dropdown', !!modEntry);
  if (modEntry) {
    modEntry.el.focus();
    await tapEnter();
    await sleep(200);
    const includesEntry = registry.get('fb-mod-title-opt-INCLUDES');
    check('F4c3 the dropdown offers "includes"', !!includesEntry);
    if (includesEntry) {
      includesEntry.el.focus();
      await tapEnter();
      await sleep(200);
    }
  }

  await clearLog();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(valueInput, 'harness');
  valueInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);

  const applyBtn = btnByText(b3, 'Apply');
  check('F4d Apply is enabled once a criterion carries a value', !!applyBtn && !applyBtn.disabled,
    applyBtn ? `disabled=${applyBtn.disabled}` : 'no Apply button');
  if (!applyBtn) return;
  applyBtn.click();
  await sleep(400);

  check('F4e applying closes the builder', !dialogNamed(/^Filter scenes/));

  // THE assertion. Translated, the stored envelope
  // `{title:{modifier:'INCLUDES', value:{value:'harness'}}}` becomes
  // `{title:{value:'harness', modifier:'INCLUDES'}}` on the wire.
  const sent = await lastSceneFilter();
  check('F4f the server received the criterion the builder composed',
    sent && sent.title && sent.title.value === 'harness' && sent.title.modifier === 'INCLUDES',
    `scene_filter: ${JSON.stringify(sent)}`);

  // …and the filter has to have *taken effect*, not merely been sent. The fake
  // listing is titled "VERIFY scene N", so "harness" matches nothing and a
  // working filter leaves the grid empty. Asserting on the request alone would
  // pass on a builder that composed a filter nobody then applied.
  await waitFor(() => !registry.has('video-1'), 3000);
  check('F4g the listing is now empty — the filter was applied, not just sent',
    !registry.has('video-1'),
    `video-1 still registered: ${registry.has('video-1')}`);

  // ── F10  the row's own controls are reachable by a remote ─
  //
  // Added after reading the component rather than after watching it fail, and
  // it is the one class of defect no other check in this file can see: every
  // press in this driver ends in a `.click()` or a dispatched event on an
  // element the driver located *itself*, so a control no remote can reach
  // behaves identically to one that works. Spatial nav searches `registry`,
  // and only `useFocusable` populates it — so the assertion is on the
  // registry, and what it covers is "the entity picker cannot be opened from
  // the TV at all", which is most of what this release adds.
  //
  // Tags, because it is multi-valued with an entity source, which is the only
  // shape that renders a pick button. Both row controls were plain <button>s
  // when this check was written.
  btnByText(document, 'Build…')?.click();
  await sleep(300);
  const b6 = dialogNamed(/^Filter scenes/);
  check('F10 could reopen the builder', !!b6);
  if (!b6) return;

  btnByText(b6, '+ Add criterion').click();
  await sleep(200);
  const tagsEntry = registry.get('fp-tags');
  check('F10 the field picker offers Tags', !!tagsEntry,
    `fp- entries: ${Array.from(registry.keys()).filter(k => k.startsWith('fp-')).join(', ')}`);
  if (tagsEntry) {
    tagsEntry.el.focus();
    await tapEnter();
    await sleep(300);
  }

  check('F10b the row offers a pick action the D-pad can reach',
    registry.has('fb-pick-tags'),
    `fb- entries: ${Array.from(registry.keys()).filter(k => k.startsWith('fb-')).join(', ')}`);
  check('F10c …and a remove action the D-pad can reach', registry.has('fb-rm-tags'));

  const pickEntry = registry.get('fb-pick-tags');
  if (pickEntry) {
    pickEntry.el.focus();
    await tapEnter();
    await sleep(300);
    check('F10d Enter on it opens the entity picker', !!dialogNamed(/^Choose/i),
      `dialogs: ${dialogs().map(d => d.getAttribute('aria-label')).join(' | ') || 'none'}`);
  }

  await press('Escape');
  await sleep(250);

  // ── F10g  Left/Right stay on the criterion row ──────────
  //
  // Reported from the TV, 2026-10-17: on a row with "This only" (the Depth
  // choice on a hierarchical field), Left went to Cancel in the footer before
  // it would reach "Choose…" on the same line. `.rowBody` wraps, so the
  // geometry had a nearer neighbour that was not on the line.
  //
  // The Tags row above is the shape in the report: F10b's dump shows it
  // renders `fb-pick-tags` *and* `fb-depth-tags`, i.e. it is HIERARCHICAL.
  // (A first draft of this block assumed it was MULTI and tried to add Scene
  // tags instead; the field picker's common scope does not offer that one, the
  // added criterion never appeared, and the leftover field-picker dialog took
  // F10f and F8 down with it. Use the row that is already there.)
  //
  // The zone assertion is the part whose failure mode does not depend on this
  // window's wrapping: on the old build every row control shared the builder's
  // zone, so Left could leave the line at all. The presses below are the
  // user's own path, and would be green on the old build at a width where the
  // row happens not to wrap.
  const activeId = () => {
    for (const [id, e] of registry) if (e.el === document.activeElement) return id;
    return document.activeElement?.tagName || 'body';
  };
  const depthEntry = registry.get('fb-depth-tags');
  const pickEntry2 = registry.get('fb-pick-tags');
  check('F10g the row’s controls are in a zone of the row’s own',
    depthEntry?.zone === 'fb-row-tags' && pickEntry2?.zone === 'fb-row-tags',
    `depth zone ${depthEntry?.zone ?? 'MISSING'}, pick zone ${pickEntry2?.zone ?? 'MISSING'}`);

  if (depthEntry && pickEntry2) {
    depthEntry.el.focus();
    await sleep(60);
    await press('ArrowLeft');
    check('F10h Left from This only reaches Choose…, not the footer',
      activeId() === 'fb-pick-tags', activeId());

    pickEntry2.el.focus();
    await sleep(60);
    await press('ArrowRight');
    check('F10i Right from Choose… returns to This only',
      activeId() === 'fb-depth-tags', activeId());
  } else {
    check('F10h Left from This only reaches Choose…, not the footer', false,
      'the row is missing its pick or depth control');
  }

  const rmEntry = registry.get('fb-rm-tags');
  if (rmEntry) {
    rmEntry.el.focus();
    await tapEnter();
    await sleep(250);
  }
  // Null-guarded: on a build where the row controls are unreachable this runs
  // with the builder in whatever state the previous check left it, and a
  // `rowLabels(null)` throws out of the check's own argument list — which
  // reports HARNESS CRASHED and hides every check after it. A control
  // experiment should produce one red line, not an abort.
  const b8 = dialogNamed(/^Filter scenes/);
  check('F10e Enter on remove drops the row',
    !!b8 && !rowLabels(b8).includes('Tags'),
    `rows: ${b8 ? rowLabels(b8).join(', ') : '<no builder>'}`);

  // Leave the builder as F4 left it: its edits are local until Apply, so a
  // Back here discards the Tags row and F6 onwards still see the working
  // filter that F4 applied.
  await press('Escape');
  await sleep(250);
  check('F10f Back still closes the builder, with nothing else on screen',
    !dialogNamed(/^Filter scenes/));

  // ── F6  the dropdown reflects it ────────────────────────
  const filterSelect = document.getElementById('ctrl-filter')
    || Array.from(document.querySelectorAll('[class*="selectBtn"]'))
      .find(b => (b.textContent || '').includes('Custom filter'));
  const filterText = filterSelect ? filterSelect.textContent.trim() : '';
  check('F6 the filter dropdown shows the in-memory filter',
    /Custom filter/.test(filterText), `dropdown reads "${filterText}"`);

  // ── F7  and clearing it puts the filter back ────────────
  //
  // Asserted on the *listing*, not on the dropdown's label and not on a
  // follow-up request. Both of those were tried first and both were checks
  // with no failure mode:
  //
  //   - the label is driven by `filterId` alone, so it reads "All" whether or
  //     not the working filter is still in force — it passed with the reducer
  //     guard deleted;
  //   - choosing All returns the filter to `null`, which is the key the first
  //     listing was fetched under, so the grid is served from
  //     `createListCache` and no request goes out to inspect.
  //
  // The grid coming back is the observable that distinguishes the two, and it
  // only works because the fake now honours a title criterion. With the guard
  // deleted the filter stays in force, the key does not change, and the grid
  // stays empty — which is the bug, visible.
  const trigger = Array.from(document.querySelectorAll('button'))
    .find(b => /Custom filter/.test(b.textContent || ''));
  check('F7 the dropdown trigger carries the working filter', !!trigger);

  if (trigger) {
    trigger.click();
    await sleep(250);
    const allOpt = Array.from(document.querySelectorAll('button, [role="option"], li'))
      .find(b => b.textContent.trim() === 'All');
    check('F7b the menu offers All', !!allOpt);
    if (allOpt) {
      allOpt.click();
      await waitFor(() => registry.has('video-1'), 3000);
      check('F7c choosing All drops the in-memory filter and the listing returns',
        registry.has('video-1'),
        registry.has('video-1') ? 'the full listing is back' : 'the grid is still filtered');
    }
  }

  // ── F8  saving ──────────────────────────────────────────
  const buildAgain = btnByText(document, 'Build…');
  buildAgain?.click();
  await sleep(250);
  const b4 = dialogNamed(/^Filter scenes/);
  if (!b4) { check('F8 could reopen the builder', false); return; }

  const addAgain = btnByText(b4, '+ Add criterion');
  addAgain?.click();
  await sleep(200);
  const p4 = dialogNamed(/Add a criterion/);
  const fpEntry = Array.from(registry.entries()).find(([id]) => id.startsWith('fp-title'));
  if (!p4 || !fpEntry) { check('F8 could add a criterion to save', false); return; }
  fpEntry[1].el.focus();
  await tapEnter();
  await sleep(250);

  const v4 = dialogNamed(/^Filter scenes/)?.querySelector('[class*="valueInput"]');
  if (!v4) { check('F8 could reach the value editor', false); return; }
  setter.call(v4, 'saveme');
  v4.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);

  const saveBtn = btnByText(dialogNamed(/^Filter scenes/), 'Save…');
  check('F8 the builder offers a Save action', !!saveBtn);
  if (!saveBtn) return;
  saveBtn.click();
  await sleep(250);

  const namePrompt = dialogNamed(/Save filter/);
  check('F8b saving asks for a name first', !!namePrompt);
  if (!namePrompt) return;

  const nameInput = namePrompt.querySelector('[class*="pickInput"]');
  setter.call(nameInput, 'Harness filter');
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);

  const confirm = btnByText(namePrompt, 'Save');
  confirm?.click();
  await sleep(600);

  const writes = await getJson('/filterwrites');
  const saved = writes.filter(w => w.op === 'save');
  check('F8c the save reached the server', saved.length === 1,
    `${saved.length} save(s): ${JSON.stringify(writes)}`);

  if (saved.length) {
    check('F8d …under SCENES, not another mode', saved[0].mode === 'SCENES', `mode ${saved[0].mode}`);
    check('F8e …carrying the builder\'s stored envelope, not GraphQL shape',
      saved[0].object_filter?.title?.value?.value === 'saveme',
      `object_filter: ${JSON.stringify(saved[0].object_filter)}`);
    check('F8f …and a sort, so reopening elsewhere is not Stash\'s default order',
      !!saved[0].find_filter?.sort, JSON.stringify(saved[0].find_filter));
    check('F8g …named', saved[0].name === 'Harness filter', `name "${saved[0].name}"`);
  }

  // ── F9  what was saved can be reopened ──────────────────
  // The failure this catches is silent: the filter appears in the dropdown and
  // loads empty. So the assertion is on the *criteria rows*, not on the
  // dropdown entry existing.
  await sleep(300);
  const store = await getJson('/savedfilters');
  check('F9 the filter is in the store after saving',
    (store.SCENES || []).length === 1,
    `store: ${JSON.stringify(store)}`);

  const reopen = btnByText(document, 'Build…');
  reopen?.click();
  await sleep(300);
  const b5 = dialogNamed(/^Filter scenes/);
  const reopenedRows = b5 ? rowLabels(b5) : [];
  check('F9b reopening the builder seeds it from the saved filter',
    reopenedRows.includes('Title'),
    `rows: ${reopenedRows.join(', ') || 'none'}`);

  // ── F11  boolean criteria count and reach the wire ──────
  // `blankCriterion` stores a boolean operand as a bare string at
  // `criterion.value`; `effective` used to look only inside `inner.value`, so
  // an "Organized — Yes" criterion could be added, was still counted as 0, and
  // Apply stayed disabled. The picker is left open by F9, so the boolean is
  // added beside the Title criterion seeded there.
  const b7 = dialogNamed(/^Filter scenes/);
  btnByText(b7, '+ Add criterion')?.click();
  await sleep(200);
  const pB = dialogNamed(/Add a criterion/);
  const orgEntry = Array.from(registry.entries()).find(([id]) => id === 'fp-organized');
  check('F11 the field picker offers Organized', !!orgEntry,
    `pick rows: ${Array.from(registry.keys()).filter(k => k.startsWith('fp-')).join(', ')}`);
  if (orgEntry) {
    check('F11a Organized has its own picker in the dialog', !!pB);
    orgEntry[1].el.focus();
    await tapEnter();
    await sleep(250);

    const b8 = dialogNamed(/^Filter scenes/);
    check('F11b the boolean criterion is counted',
      /2 criteria/.test(b8?.textContent || ''),
      `footer: "${(b8?.textContent || '').slice(-120)}"`);

    const applyB = btnByText(b8, 'Apply');
    check('F11c Apply stays enabled with the boolean', !!applyB && !applyB.disabled,
      applyB ? `disabled=${applyB.disabled}` : 'no Apply button');
    if (applyB && !applyB.disabled) {
      await clearLog();
      applyB.click();
      await sleep(500);
      const sentB = await lastSceneFilter();
      check('F11d the boolean reached the wire as a Boolean',
        sentB && sentB.organized === true,
        `scene_filter: ${JSON.stringify(sentB)}`);
    }
  }

  // ── F12  a tag activation seeds the builder ─────────────
  // Activating a tag puts the *GraphQL* shape into `workingFilter`
  // (`{value:[id]}`). The builder used to seed straight from it, so the Tags
  // row rendered "Choose…", the count read 0 and Apply was disabled — while a
  // tag filter was patently applied. The seed conversion is what this checks.
  registry.get('nav-tags')?.el.focus();
  await sleep(120);
  await tapEnter();
  await sleep(600);
  const hasTag = await waitFor(() => registry.has('tag-3'), 4000);
  check('F12 could reach a tag', hasTag,
    `registry has tag-3: ${registry.has('tag-3')}; rail: ${document.querySelector('nav')?.textContent?.slice(0, 40)}`);
  if (hasTag) {
    registry.get('tag-3').el.focus();
    await sleep(120);
    await tapEnter();
    await sleep(800);

    const buildTagged = btnByText(document, 'Build…');
    check('F12a the activated tag opened a filtered Scenes listing', !!buildTagged);
    buildTagged?.click();
    await sleep(300);

    const b9 = dialogNamed(/^Filter scenes/);
    check('F12b the builder seeds the tag criterion as a row',
      rowLabels(b9).includes('Tags'),
      `rows: ${rowLabels(b9).join(', ') || 'none'}`);

    const applyC = btnByText(b9, 'Apply');
    check('F12c …and counts it, so Apply is enabled', !!applyC && !applyC.disabled,
      applyC ? `disabled=${applyC.disabled}` : 'no Apply button');
    if (applyC && !applyC.disabled) {
      await clearLog();
      applyC.click();
      await sleep(500);
      const sentC = await lastSceneFilter();
      check('F12d applying keeps the tag on the wire',
        sentC && sentC.tags && sentC.tags.value && sentC.tags.value[0] === '3',
        `scene_filter: ${JSON.stringify(sentC)}`);
    }
  }

  // ── H  a mode switch does not leave the old mode's filters on screen ──
  // Filter ids are namespaced by mode, so a scene filter left selectable
  // under Performers is a criterion that cannot resolve. App never switches
  // to a mode whose read fails with a saved filter already showing, which is
  // why this drives the hook directly: the clear is a property of the hook,
  // and the failing read is what keeps the old bug observable (on success
  // the new list arrives and the stale rows vanish for the wrong reason).
  await fetch(`http://127.0.0.1:${PORT}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation Seed($input: SaveFilterInput!) { saveFilter(input: $input) { id name } }',
      variables: { input: { mode: 'scenes', name: 'VERIFY stale scene filter' } },
    }),
  });
  const probeRoot = document.createElement('div');
  document.body.appendChild(probeRoot);
  createRoot(probeRoot).render(
    <SavedFilterProbe initialMode="scenes" source="probe-h" />,
  );
  const probeLoaded = await waitFor(
    () => probeState.names.includes('VERIFY stale scene filter'), 4000);
  check('H0 the probe hook loaded the saved filter for its own mode', probeLoaded,
    `mode=${probeState.mode} names=${JSON.stringify(probeState.names)}`);

  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ savedFilters: 'fail' }),
  });
  document.getElementById('probe-switch-mode').click();
  const probeFailed = await waitFor(() => probeState.error !== null, 4000);
  check('H1 switching mode clears the previous mode\'s filters',
    probeFailed && probeState.mode === 'performers' && probeState.names.length === 0,
    `mode=${probeState.mode} error=${JSON.stringify(probeState.error)} `
    + `names=${JSON.stringify(probeState.names)}`);
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ savedFilters: 'ok' }),
  });

  // ── H2  a *source* change clears them too ───────────────
  // The same trap as H1, one level up: a saved id names a row on one Stash
  // instance. Kept across a server switch it either names nothing — the
  // listing runs unfiltered while the bar shows a filter — or, worse, names a
  // different filter entirely. The failing read keeps the old rows the only
  // thing that could be on screen.
  document.getElementById('probe-switch-mode').click();    // back to scenes
  const reloaded = await waitFor(
    () => probeState.names.includes('VERIFY stale scene filter'), 4000);
  check('H2 setup: the scene filter is showing again', reloaded,
    `mode=${probeState.mode} names=${JSON.stringify(probeState.names)}`);
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ savedFilters: 'fail' }),
  });
  document.getElementById('probe-switch-source').click();
  const sourceCleared = await waitFor(() => probeState.error !== null, 4000);
  check('H2 switching data source clears the previous source\'s filters',
    sourceCleared && probeState.source === 'probe-h-other' && probeState.names.length === 0,
    `source=${probeState.source} error=${JSON.stringify(probeState.error)} `
    + `names=${JSON.stringify(probeState.names)}`);
  await fetch(`http://127.0.0.1:${PORT}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ savedFilters: 'ok' }),
  });

  check('no uncaught errors', errors.length === 0, errors.slice(-3).join(' | ') || 'none');
}

const root = document.getElementById('root');
document.body.style.margin = '0';

setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(root).render(<App />);

run()
  .then(async () => {
    await fetch('/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results, null, 2),
    });
    await fetch('/done', { method: 'POST' });
  })
  .catch(async (e) => {
    results.push({
      name: 'HARNESS CRASHED',
      pass: false,
      detail: `${(e && e.message) || e}\n${(e && e.stack) || ''}`,
    });
    await fetch('/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results, null, 2),
    });
    await fetch('/done', { method: 'POST' });
  });
