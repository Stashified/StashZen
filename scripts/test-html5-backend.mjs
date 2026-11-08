#!/usr/bin/env node
/**
 * test-html5-backend.mjs: the browser backend stops its element on teardown
 *
 *   node scripts/test-html5-backend.mjs
 *
 * A <video> removed from the document keeps playing its audio, so `detach`
 * (React unmount and engine switch) and `close` (an exhausted plan) must pause
 * and unload the element before dropping it.
 */

const { createHtml5Backend } = await import('../src/components/player/engine/html5Backend.js');
const { MEDIA_EVENTS } = await import('../src/components/player/engine/contracts.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function makeElement() {
  const element = {
    src: '',
    paused: true,
    defaultPlaybackRate: 1,
    playbackRate: 1,
    calls: { pause: 0, load: 0, removeSrc: 0, added: [], removed: [] },
    addEventListener(type, handler) {
      this.calls.added.push(type);
      this.handlers.set(type, handler);
    },
    removeEventListener(type) {
      this.calls.removed.push(type);
      this.handlers.delete(type);
    },
    pause() { this.calls.pause += 1; this.paused = true; },
    removeAttribute(name) {
      if (name === 'src') { this.calls.removeSrc += 1; this.src = ''; }
    },
    load() { this.calls.load += 1; },
    handlers: new Map(),
  };
  return element;
}

// ── attach, open, detach ─────────────────────────────────
{
  const emitted = [];
  const backend = createHtml5Backend({ emit: type => emitted.push(type) });
  const element = makeElement();

  backend.attach(element);
  check('attach subscribes to every media event',
    MEDIA_EVENTS.every(type => element.calls.added.includes(type)),
    `added=${element.calls.added.length}`);

  backend.open('https://example.test/stream.m3u8');
  check('open sets the element source', element.src === 'https://example.test/stream.m3u8');
  check('open loads the element', element.calls.load === 1, `loads=${element.calls.load}`);

  element.paused = false;
  backend.detach();
  check('detach pauses a playing element', element.calls.pause === 1, `pauses=${element.calls.pause}`);
  check('detach clears the source', element.calls.removeSrc === 1 && element.src === '');
  check('detach reloads to release the stream', element.calls.load === 2, `loads=${element.calls.load}`);
  check('detach removes every listener',
    MEDIA_EVENTS.every(type => element.calls.removed.includes(type)),
    `removed=${element.calls.removed.length}`);
  check('detach reports the video as paused', backend.paused === true);
}

// ── close while attached ─────────────────────────────────
{
  const backend = createHtml5Backend({ emit: () => {} });
  const element = makeElement();
  backend.attach(element);
  backend.close();
  check('close pauses the element', element.calls.pause === 1, `pauses=${element.calls.pause}`);
  check('close clears the source', element.calls.removeSrc === 1);
  check('close reloads to release the stream', element.calls.load === 1);
}

// ── a replaced element is stopped too ───────────────────
{
  const backend = createHtml5Backend({ emit: () => {} });
  const first = makeElement();
  const second = makeElement();
  backend.attach(first);
  backend.attach(second);
  check('replacing the element stops the old one',
    first.calls.pause === 1 && first.calls.removeSrc === 1,
    JSON.stringify(first.calls));
  check('the new element is attached', second.calls.added.length === MEDIA_EVENTS.length);
}

// ── events are re-dispatched from the facade ────────────
{
  const emitted = [];
  const backend = createHtml5Backend({ emit: type => emitted.push(type) });
  const element = makeElement();
  backend.attach(element);
  element.handlers.get('play')?.();
  element.handlers.get('ended')?.();
  check('element events reach the facade in order',
    emitted.join(',') === 'play,ended', emitted.join(','));
}

// ── teardown without an element is safe ─────────────────
{
  const backend = createHtml5Backend({ emit: () => {} });
  let threw = false;
  try {
    backend.detach();
    backend.close();
  } catch {
    threw = true;
  }
  check('detach and close without an element do not throw', !threw);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
