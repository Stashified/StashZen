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

import {
  queueOf, queueItemFromMarker, markerQueueItems, queueFromMarkers,
} from '../src/utils/playQueue.js';
import {
  buildSceneMenuItems, buildMarkerMenuItems, buildImageMenuItems,
  buildGalleryMenuItems, buildActionMenu,
} from '../src/utils/actionMenus.js';

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
const items = buildSceneMenuItems({ item: card, list: listing, index: 1 }, { openPlayer, onDetails });
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

const single = buildSceneMenuItems({ item: card, list: null, index: 0 }, { openPlayer, onDetails });
check('a card with no listing gets only Play and Details',
  single.map(i => i.id), ['menu-play', 'menu-details']);

// ── Markers ────────────────────────────────────────────────
// Two markers on one scene are two timestamps into one video. The player's
// queue is keyed by scene, so the listing must collapse them — and the second
// marker must still be able to *start* the queue at its own timestamp.
const marker2 = { ...marker, id: 'm2', title: 'Marker Two', seconds: 640 };
const otherScene = { ...card, id: '43' };
const marker3 = { ...marker, id: 'm3', title: 'Marker Three', seconds: 1905, scene: otherScene };
const markerListing = {
  items: [marker, marker2, marker3], total: 3, page: 1,
  fetchPage: (page) => Promise.resolve({
    items: page === 2 ? [{ ...marker, id: 'm4', seconds: 60, scene: otherScene }] : [],
    total: 3,
  }),
};

console.log('markerQueueItems');
const sameScene = markerQueueItems([marker, marker2]);
check('two markers on one scene are one queue row', sameScene.length, 1);
check('the first marker supplies its timestamp', sameScene[0].startSeconds, 125);
check('the row is still the scene', sameScene[0].id, '42');
check('a different scene is kept', markerQueueItems([marker, marker3]).map(i => i.id), ['42', '43']);

console.log('queueFromMarkers');
const mq = queueFromMarkers(markerListing, [marker, marker2, marker3]);
check('the seed has one row per scene', mq.items.map(i => i.id), ['42', '43']);
check('the queue starts at the first seed marker time', mq.startSeconds, 125);
check('total stays the marker count — an upper bound, not a promise', mq.total, 3);
check('the queue keeps the listing page for extension', mq.page, 1);
check('the start index is zero — the seed has already been reduced', mq.startIndex, 0);

// The extension adapter has to dedupe *within* a page too: usePlayQueue
// filters against what it has already kept, not against the same page.
const pageRows = await mq.fetchPage(2);
check('extension pages are mapped to scene rows and deduped', pageRows.items.map(i => i.id), ['43']);

const flipped = queueFromMarkers({ ...markerListing, page: 2 }, [marker3]);
check('a queue from a later page extends from that page', flipped.page, 2);

console.log('buildMarkerMenuItems');
const mCalls = [];
const mOpen = (session) => mCalls.push(session);
const mDetails = (video) => mCalls.push({ details: video });
const markerMenu = buildMarkerMenuItems(
  { item: marker2, list: markerListing, index: 1 },
  { openPlayer: mOpen, onDetails: mDetails },
);
check('a marker listing gets Play, Play all, Play from here and Details',
  markerMenu.map(i => i.id), ['menu-play', 'menu-play-all', 'menu-play-here', 'menu-details']);
check('Play is labelled with the marker time', markerMenu[0].hint, '10:40');
check('Play from here counts distinct scenes from the pressed marker',
  markerMenu[2].hint, '2 scenes');

markerMenu[0].onSelect();
check('Play opens one scene at its marker time',
  [mCalls.at(-1).startSeconds, mCalls.at(-1).items[0].id], [640, '42']);
markerMenu[1].onSelect();
check('Play all starts at the first loaded marker and walks scenes',
  [mCalls.at(-1).startSeconds, mCalls.at(-1).items.map(i => i.id)], [125, ['42', '43']]);
markerMenu[2].onSelect();
check('Play from here starts at the pressed marker',
  [mCalls.at(-1).startSeconds, mCalls.at(-1).items.map(i => i.id)], [640, ['42', '43']]);
markerMenu[3].onSelect();
check('Details opens the parent scene page', mCalls.at(-1), { details: card });

const noMarkerListing = buildMarkerMenuItems(
  { item: marker, list: null, index: 0 }, { openPlayer: mOpen, onDetails: mDetails },
);
check('a marker with no listing gets only Play and Details',
  noMarkerListing.map(i => i.id), ['menu-play', 'menu-details']);

console.log('buildActionMenu');
const markerAction = buildActionMenu(
  { kind: 'marker', item: marker, list: markerListing, index: 0 },
  { openPlayer: mOpen, onDetails: mDetails },
);
check('the marker menu names the marker and its scene time',
  [markerAction.title, markerAction.subtitle], ['Marker One', 'at 2:05 in A Scene']);
check('the marker menu rows are the marker rows',
  markerAction.items.map(i => i.id),
  ['menu-play', 'menu-play-all', 'menu-play-here', 'menu-details']);

// ── Images ─────────────────────────────────────────────────
const imgA = { id: 'i1', title: 'A' };
const imgB = { id: 'i2', title: 'B' };
const imgListing = { items: [imgA, imgB], total: 2 };
const imageCalls = [];
const imageMenu = buildImageMenuItems(
  { item: imgB, list: imgListing, index: 1 },
  { openImageViewer: (d) => imageCalls.push(d) },
);
check('an image gets View, two slideshow entries and Info',
  imageMenu.map(i => i.id),
  ['menu-image-view', 'menu-image-slideshow-here', 'menu-image-slideshow-start', 'menu-image-info']);
check('the slideshow hint counts what is loaded', imageMenu[1].hint, '1 left');

imageMenu[0].onSelect();
check('View opens the viewer on the pressed image',
  [imageCalls.at(-1).index, imageCalls.at(-1).items.length, imageCalls.at(-1).autoPlay],
  [1, 2, undefined]);
imageMenu[1].onSelect();
check('Slideshow from here runs from the pressed image',
  [imageCalls.at(-1).index, imageCalls.at(-1).autoPlay], [1, true]);
imageMenu[2].onSelect();
check('Slideshow from start runs from the first',
  [imageCalls.at(-1).index, imageCalls.at(-1).autoPlay], [0, true]);
imageMenu[3].onSelect();
check('Info opens the viewer with the panel up',
  [imageCalls.at(-1).index, imageCalls.at(-1).infoOpen], [1, true]);

const oneImage = buildImageMenuItems(
  { item: imgA, list: { items: [imgA], total: 1 }, index: 0 },
  { openImageViewer: () => {} },
);
check('a single image has no slideshow to offer',
  oneImage.map(i => i.id), ['menu-image-view', 'menu-image-info']);

// ── Galleries ──────────────────────────────────────────────
const gallery = { id: 'g1', title: 'A Gallery', image_count: 5 };
const galleryCalls = [];
const galleryMenu = buildGalleryMenuItems(
  { item: gallery },
  {
    openGallery: (g) => galleryCalls.push({ view: g }),
    openGallerySlideshow: (g, opts) => galleryCalls.push({ slideshow: g, opts }),
  },
);
check('a gallery gets View images, Slideshow and Shuffle slideshow',
  galleryMenu.map(i => i.id),
  ['menu-gallery-view', 'menu-gallery-slideshow', 'menu-gallery-shuffle']);
galleryMenu[0].onSelect();
check('View images hands the gallery to the tab hand-off',
  galleryCalls.at(-1), { view: gallery });
galleryMenu[1].onSelect();
check('Slideshow asks for an ordered run',
  galleryCalls.at(-1), { slideshow: gallery, opts: { shuffle: false } });
galleryMenu[2].onSelect();
check('Shuffle slideshow asks for a shuffled one',
  galleryCalls.at(-1), { slideshow: gallery, opts: { shuffle: true } });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
