#!/usr/bin/env node
/**
 * test-play-queue.mjs — what the player is opened with, and what it inherits
 *
 *   node scripts/test-play-queue.mjs
 *
 * Two objects decide what a playback session contains. `queueOf` is the
 * "nothing to extend into" queue used by the detail page's Play and by a
 * marker. `queueItemFromMarker` builds the one queue item that is written by
 * hand instead of taken from a grid card, and every field it forwards is a
 * field the player needs: skimming, codec refusal and the timeline each read
 * this object. A missing field degrades silently — a marker on an HEVC scene
 * simply plays instead of prompting to transcode — so the fields are pinned
 * here rather than left to the harness, which drives the DOM.
 *
 * `buildSceneMenuItems` is asserted too: the card's listing decides whether
 * "Play all" and "Play from here" exist at all. No framework, same as
 * test-criterion-draft.mjs.
 */

import { queueOf, queueItemFromMarker } from '../src/utils/playQueue.js';
import { buildSceneMenuItems } from '../src/utils/sceneMenu.js';

let failed = 0;
let passed = 0;

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',') + '}';
  }
  return JSON.stringify(v);
}

function check(label, actual, expected) {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

const card = {
  id: '42',
  title: 'A Scene',
  stream: '/scene/42/stream',
  screenshot: '/scene/42/screenshot',
  sprite: '/scene/42/sprite',
  vtt: '/scene/42/vtt',
  videoCodec: 'hevc',
  audioCodec: 'eac3',
  container: 'mkv',
  durationSeconds: 901.5,
};

const marker = {
  id: 'm1',
  title: 'Marker One',
  seconds: 125,
  screenshot: '/marker/m1/screenshot',
  scene: card,
};

console.log('queueOf');
check('a single video is a queue of one with nowhere to extend', queueOf(card),
  {
    items: [card], total: 1, page: 1, startIndex: 0, startSeconds: 0, fetchPage: null,
  });
check('the start position travels', queueOf(card, 125).startSeconds, 125);
check('the item is the card itself, not a copy', queueOf(card).items[0] === card, true);
check('there is no page to extend into', queueOf(card).fetchPage, null);

console.log('queueItemFromMarker');
const item = queueItemFromMarker(marker);
check('the id is the parent scene', item.id, '42');
check('the title names marker and scene', item.title, 'A Scene — Marker One');
check('the stream is the parent scene stream', item.stream, '/scene/42/stream');
check('the thumbnail prefers the marker screenshot', item.thumbnail, '/marker/m1/screenshot');
check('the sprite is forwarded for skimming', item.sprite, '/scene/42/sprite');
check('the vtt is forwarded for skimming', item.vtt, '/scene/42/vtt');
check('the video codec is forwarded for the decode check', item.videoCodec, 'hevc');
check('the audio codec is forwarded for the decode check', item.audioCodec, 'eac3');
check('the container is forwarded for the decode check', item.container, 'mkv');
check('the duration is forwarded for the timeline', item.durationSeconds, 901.5);
check('a marker carries no studio', item.studio, null);

const noShot = { ...marker, screenshot: undefined };
check('without a marker screenshot, the scene\'s is used',
  queueItemFromMarker(noShot).thumbnail, '/scene/42/screenshot');

console.log('buildSceneMenuItems');
const calls = [];
const openPlayer = (session) => calls.push(session);
const onDetails = (video) => calls.push({ details: video });

const listing = { items: [card, { ...card, id: '43' }], total: 2, page: 1, startIndex: 1 };
const items = buildSceneMenuItems({ video: card, list: listing, index: 1 }, { openPlayer, onDetails });
check('a listing card gets Play, Play all, Play from here and Details',
  items.map(i => i.id), ['menu-play', 'menu-play-all', 'menu-play-here', 'menu-details']);
check('Play all names the start', items[1].hint, 'from the start');
check('Play from here counts what is left', items[2].hint, '1 left');

items[0].onSelect();
check('Play opens a queue of one at the start',
  calls.at(-1), { items: [card], total: 1, page: 1, startIndex: 0, startSeconds: 0, fetchPage: null });
items[1].onSelect();
check('Play all keeps the listing and starts at its first item',
  [calls.at(-1).startIndex, calls.at(-1).startSeconds, calls.at(-1).items.length], [0, 0, 2]);
items[2].onSelect();
check('Play from here starts at the pressed card',
  [calls.at(-1).startIndex, calls.at(-1).startSeconds], [1, 0]);
items[3].onSelect();
check('Details hands the card back', calls.at(-1), { details: card });

const single = buildSceneMenuItems({ video: card, list: null, index: 0 }, { openPlayer, onDetails });
check('a card with no listing gets only Play and Details',
  single.map(i => i.id), ['menu-play', 'menu-details']);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
