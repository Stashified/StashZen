#!/usr/bin/env node
/**
 * test-api-batch.mjs — the normalisers and pure helpers behind the
 * enrichment batch (performer profile, image info, entity heroes, job
 * details).
 *
 *   node scripts/test-api-batch.mjs
 *
 * These are the pieces the harness cannot see cheaply: every normaliser is a
 * pure mapping from a GraphQL answer to the shape a page draws, and the two
 * common failure modes — keeping a field the query no longer asks for, and
 * hiding an empty value behind truthiness the page then prints — are decided
 * here rather than at 1080p.
 *
 * No framework, same as test-request-key.mjs. The render paths (the hero's
 * blurb, the Stop button, the gallery chips) are the DOM harness's job.
 */

import {
  normalizePerformerDetail,
} from '../src/utils/performerService.js';
import { normalizeGallery } from '../src/utils/galleryService.js';
import { normalizeTag } from '../src/utils/tagService.js';
import { normalizeStudio } from '../src/utils/studioService.js';
import { normalizeSceneDetail } from '../src/utils/sceneService.js';
import { normalizeImageDetail } from '../src/utils/imageService.js';
import { normalizeServerStatus } from '../src/utils/serverService.js';
import { buildImageInfoRows } from '../src/utils/imageInfo.js';
import { formatJobStart } from '../src/utils/format.js';
import {
  webLinks, formatCareer, formatHeight, formatGender, ratingFromCard,
} from '../src/pages/performerDetail/format.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Performer detail — items 4/5, plus the write authority fields (6)
// ═══════════════════════════════════════════════════════════
const FULL_PERFORMER = {
  id: '8701',
  gender: 'NON_BINARY',
  alias_list: ['alias one', null, 'alias two'],
  career_start: '1999-04-01',
  career_end: '2011-09-30',
  career_length: '99 years',
  tattoos: 'anchor',
  measurements: '34-24-35',
  ethnicity: 'IRISH',
  hair_color: 'BROWN',
  eye_color: 'BLUE',
  weight: 60,
  piercings: 'ears',
  fake_tits: 'no',
  death_date: null,
  o_counter: 12,
  image_count: 34,
  gallery_count: 5,
  urls: ['https://a.example/one', '', null, 'https://b.example/two'],
  tags: [{ id: 't1', name: 'tag one' }, { id: 't2', name: 'tag two' }],
  rating100: 75,
  favorite: true,
  // The deprecated single-value field. The client must not map it — the
  // output having no `url` key is how a stale mapping shows up here.
  url: 'https://old.example/deprecated',
};

const P = normalizePerformerDetail(FULL_PERFORMER);

check('performer: the new profile fields map',
  P.ethnicity === 'IRISH' && P.hairColor === 'BROWN' && P.eyeColor === 'BLUE'
    && P.weight === 60 && P.piercings === 'ears' && P.fakeTits === 'no',
  JSON.stringify({ ethnicity: P.ethnicity, hair: P.hairColor, eyes: P.eyeColor }));

check('performer: counts and death date map',
  P.oCounter === 12 && P.imageCount === 34 && P.galleryCount === 5
    && P.deathDate === null,
  `${P.oCounter}/${P.imageCount}/${P.galleryCount}/${P.deathDate}`);

check('performer: urls are the list, with empty entries dropped',
  JSON.stringify(P.urls) === JSON.stringify([
    'https://a.example/one', 'https://b.example/two',
  ]),
  JSON.stringify(P.urls));

check('performer: the deprecated `url` is not carried',
  !Object.prototype.hasOwnProperty.call(P, 'url'),
  Object.keys(P).join(','));

check('performer: tags are {id,name} pairs',
  P.tags.length === 2 && P.tags[1].id === 't2' && P.tags[1].name === 'tag two',
  JSON.stringify(P.tags));

check('performer: aliases drop the null',
  JSON.stringify(P.aliases) === JSON.stringify(['alias one', 'alias two']),
  JSON.stringify(P.aliases));

check('performer: rating and favourite are fetched for write authority',
  P.rating100 === 75 && P.favorite === true,
  `${P.rating100}/${P.favorite}`);

check('performer: a live row is writable', P.writable === true, String(P.writable));

const S = normalizePerformerDetail({ id: '1' });
check('performer: a sparse row is still a complete shape',
  S.rating100 === null && S.favorite === false && S.urls.length === 0
    && S.tags.length === 0 && S.oCounter === 0 && S.ethnicity === null,
  JSON.stringify(S));
check('performer: null in, null out', normalizePerformerDetail(null) === null);

// ── Web links ───────────────────────────────────────────────
const links = webLinks([
  'https://a.example/one',
  'https://a.example/two',          // same host — the duplicate a chip-per-URL would print twice
  'https://b.example/three',
  'https://c.example/four',
  'https://d.example/five',
]);
check('links: one chip per host, first URL wins',
  links.links.length === 3 && links.links[0].url === 'https://a.example/one'
    && links.links[0].host === 'a.example',
  JSON.stringify(links.links));
check('links: the ones past the cap are counted, not dropped silently',
  links.omitted === 1, String(links.omitted));
check('links: every host is distinct',
  new Set(links.links.map(l => l.host)).size === links.links.length,
  JSON.stringify(links.links.map(l => l.host)));
check('links: an unparseable entry stays readable',
  webLinks(['not a url']).links[0].host === 'not a url',
  JSON.stringify(webLinks(['not a url'])));
check('links: empty and missing lists are empty results',
  webLinks([]).links.length === 0 && webLinks(undefined).links.length === 0
    && webLinks(undefined).omitted === 0);

// ── Hero formatters ─────────────────────────────────────────
check('career: bounds beat the free-text length',
  formatCareer({ careerStart: '1999-04-01', careerEnd: '2011-09-30', careerLength: '99 years' })
    === '1999–2011');
check('career: one bound opens the range',
  formatCareer({ careerStart: '1999-04-01' }) === '1999–'
    && formatCareer({ careerEnd: '2011-09-30' }) === '–2011');
check('career: length is the fallback only',
  formatCareer({ careerLength: '12 years' }) === '12 years');
// 182 cm is 71.65 in → 72 → 6′0″. Rounding only the remainder prints 5′12″.
check('height: the inch carries into the foot at the boundary',
  formatHeight(182) === '182 cm · 6′0″', formatHeight(182));
check('height: absurd input still formats',
  formatHeight(1) === '1 cm · 0′0″', formatHeight(1));
check('gender: known enum reads as a word',
  formatGender('NON_BINARY') === 'Non-binary' && formatGender('FEMALE') === 'Female');
check('gender: an unknown enum is de-snaked rather than dropped',
  formatGender('SOMETHING_NEW') === 'something new', formatGender('SOMETHING_NEW'));
check('ratingFromCard: the display string scales back to 0–100',
  ratingFromCard({ rating: '7.5' }) === 75
    && ratingFromCard({ rating: '10.0' }) === 100
    && ratingFromCard({}) === 0,
  `${ratingFromCard({ rating: '7.5' })}`);

// ═══════════════════════════════════════════════════════════
// Gallery / tag / studio listings — items 8/9
// ═══════════════════════════════════════════════════════════
const G = normalizeGallery({
  id: '4',
  title: 'Gallery four',
  paths: { cover: '/gallery/4/cover.png' },
  image_count: 12,
  file_count: 3,
  performer_count: 1,
  tag_count: 2,
  rating100: 65,
  organized: false,
  date: '2024-03-09',
  studio: { id: '9', name: 'Studio nine' },
  photographer: 'Shooter Nine',
  folder: { basename: '1999-04 Set' },
});
check('gallery: the hero fields map',
  G.studio?.id === '9' && G.studio?.name === 'Studio nine'
    && G.photographer === 'Shooter Nine' && G.folder === '1999-04 Set',
  JSON.stringify({ studio: G.studio, photographer: G.photographer, folder: G.folder }));
check('gallery: the cover rename still happens',
  typeof G.image_path === 'string' && G.image_path.includes('/gallery/4/cover.png'),
  String(G.image_path));
const G0 = normalizeGallery({ id: '5', title: 'Bare', paths: {} });
check('gallery: empty enrichment becomes null, not undefined strings',
  G0.studio === null && G0.photographer === null && G0.folder === null,
  JSON.stringify({ studio: G0.studio, photographer: G0.photographer, folder: G0.folder }));

const T = normalizeTag({
  id: '3', name: 'Tag three', image_path: null,
  description: 'A description', aliases: ['alt one', '', 'alt two'],
});
const T0 = normalizeTag({ id: '4', name: 'Bare tag', image_path: null });
check('tag: description and aliases map, empty aliases dropped',
  T.description === 'A description'
    && JSON.stringify(T.aliases) === JSON.stringify(['alt one', 'alt two']),
  JSON.stringify({ description: T.description, aliases: T.aliases }));
check('tag: an undescribed tag is null/empty rather than ""',
  T0.description === null && T0.aliases.length === 0,
  `${T0.description}/${JSON.stringify(T0.aliases)}`);

const ST = normalizeStudio({
  id: '2', name: 'Child studio', image_path: null, rating100: 80,
  parent_studio: { id: '1', name: 'Parent studio' },
  aliases: ['Alias one', ''],
  details: 'Studio details',
});
const ST0 = normalizeStudio({ id: '1', name: 'Root studio', image_path: null });
check('studio: parent, aliases and details map',
  ST.parentStudio?.name === 'Parent studio'
    && JSON.stringify(ST.aliases) === JSON.stringify(['Alias one'])
    && ST.details === 'Studio details',
  JSON.stringify({ parent: ST.parentStudio, aliases: ST.aliases, details: ST.details }));
check('studio: a root studio has no parent',
  ST0.parentStudio === null && ST0.aliases.length === 0 && ST0.details === null);

// ═══════════════════════════════════════════════════════════
// Scene detail galleries — item 13
// ═══════════════════════════════════════════════════════════
const sceneBase = {
  id: '4242', title: 'Scene', rating100: 0, o_counter: 0, play_count: 0,
  play_duration: 0, resume_time: 0, urls: [], tags: [], performers: [],
  scene_markers: [], files: [], paths: {},
};
const D = normalizeSceneDetail({
  ...sceneBase,
  galleries: [{ id: '7001', title: 'Gallery one' }, { id: '7002', title: null }],
});
check('scene: galleries map to {id,title}',
  D.galleries.length === 2 && D.galleries[0].id === '7001'
    && D.galleries[1].title === 'Gallery 7002',
  JSON.stringify(D.galleries));
check('scene: a missing galleries list is empty, not undefined',
  Array.isArray(normalizeSceneDetail(sceneBase).galleries)
    && normalizeSceneDetail(sceneBase).galleries.length === 0);

// ═══════════════════════════════════════════════════════════
// Image detail — item 7
// ═══════════════════════════════════════════════════════════
const IM = normalizeImageDetail({
  id: '55',
  title: 'Image 55',
  date: '2024-03-09',
  details: 'Details',
  code: 'CODE-55',
  rating100: 75,
  o_counter: 3,
  studio: { id: '1', name: 'Studio one' },
  photographer: 'Shooter',
  tags: [{ id: 't1', name: 'Tag one' }],
  performers: [{ id: 'p1', name: 'Performer one' }],
  galleries: [{ id: 'g1', title: 'Gallery one' }],
  // The union field, with the inline fragment's answer. `files` does not
  // exist on Image at all — a normaliser reading it would report 0 B here.
  visual_files: [{ size: 2048, width: 1920, height: 1080 }],
  paths: { thumbnail: '/image/55/thumb.png', image: '/image/55/full.png', preview: null },
});
check('image: file facts come from visual_files',
  IM.fileSize === 2048 && IM.width === 1920 && IM.height === 1080 && IM.fileCount === 1,
  `${IM.fileSize}/${IM.width}x${IM.height}/${IM.fileCount}`);
check('image: relational fields map',
  IM.studio?.name === 'Studio one' && IM.photographer === 'Shooter'
    && IM.tags.length === 1 && IM.performers.length === 1 && IM.galleries.length === 1,
  JSON.stringify({ studio: IM.studio, tags: IM.tags }));
check('image: paths map and a missing preview is null',
  typeof IM.thumbnail === 'string' && typeof IM.image === 'string' && IM.preview === null,
  `${IM.thumbnail} ${IM.image} ${IM.preview}`);

// ── Info rows ───────────────────────────────────────────────
const rows = buildImageInfoRows(IM);
const keys = rows.map(r => r.key);
check('info: every populated field becomes a row, in order',
  JSON.stringify(keys) === JSON.stringify([
    'studio', 'photographer', 'code', 'resolution', 'size', 'rating', 'likes',
    'tags', 'performers', 'galleries', 'details',
  ]),
  keys.join(','));
check('info: resolution and size are formatted, not raw',
  rows.find(r => r.key === 'resolution').value === '1920×1080'
    && rows.find(r => r.key === 'size').value === '2 KiB',
  `${rows.find(r => r.key === 'resolution').value} / ${rows.find(r => r.key === 'size').value}`);

const emptyRows = buildImageInfoRows({
  id: '1', studio: null, photographer: null, code: null, width: null, height: null,
  fileSize: 0, rating100: 0, oCounter: 0, tags: [], performers: [], galleries: [],
  details: null,
});
check('info: an image with nothing to say produces no rows',
  emptyRows.length === 0, emptyRows.map(r => r.key).join(','));

const capped = buildImageInfoRows({
  ...IM,
  tags: Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `t${i}` })),
  galleries: Array.from({ length: 6 }, (_, i) => ({ id: String(i), title: `g${i}` })),
});
check('info: tag and gallery lists cap with a +N count',
  capped.find(r => r.key === 'tags').value.endsWith('+2')
    && capped.find(r => r.key === 'galleries').value.endsWith('+2'),
  `${capped.find(r => r.key === 'tags').value} / ${capped.find(r => r.key === 'galleries').value}`);
check('info: long free text is marked for the clamp',
  capped.find(r => r.key === 'details').clamp === true);

// ═══════════════════════════════════════════════════════════
// Server jobs — item 10
// ═══════════════════════════════════════════════════════════
const STATUS = normalizeServerStatus({
  version: { version: '0.31.1' },
  systemStatus: { status: 'OK', appSchema: 31, databaseSchema: 31 },
  jobQueue: [
    {
      id: 'j1', status: 'RUNNING', description: 'Scanning', progress: 0.42,
      subTasks: ['Reading files', null, 'Generating previews', 42],
      error: null, startTime: '2024-05-01T09:30:00Z',
    },
    { id: 'j2', status: 'FAILED', description: 'Thumbs', progress: null,
      subTasks: [], error: 'disk full', startTime: null },
    { id: 'j3', status: 'FINISHED', description: 'Done', progress: 1.0 },
    { id: 'j4', status: 'CANCELLED', description: 'Gone', progress: 0.1 },
    { id: 'j5', status: 'READY', description: 'Queued', progress: null },
  ],
});
check('status: active jobs survive, finished and cancelled do not',
  STATUS.jobs.map(j => j.id).join(',') === 'j1,j2,j5',
  STATUS.jobs.map(j => j.id).join(','));
check('status: subtasks drop non-strings',
  JSON.stringify(STATUS.jobs[0].subTasks)
    === JSON.stringify(['Reading files', 'Generating previews']),
  JSON.stringify(STATUS.jobs[0].subTasks));
check('status: error and startTime map',
  STATUS.jobs[1].error === 'disk full'
    && STATUS.jobs[0].startTime === '2024-05-01T09:30:00Z'
    && STATUS.jobs[0].error === null
    && STATUS.jobs[2].startTime === null,
  JSON.stringify(STATUS.jobs.map(j => [j.error, j.startTime])));
check('status: a missing progress stays null rather than becoming 0',
  STATUS.jobs[1].progress === null, String(STATUS.jobs[1].progress));

check('status: at most three jobs are shown',
  normalizeServerStatus({
    jobQueue: Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`, status: 'RUNNING', description: `job ${i}`,
    })),
  }).jobs.length === 3);
check('status: a missing queue is an empty list',
  normalizeServerStatus({}).jobs.length === 0);
check('status: null in, null out', normalizeServerStatus(null) === null);

// ── Start time ──────────────────────────────────────────────
const iso = '2024-05-01T09:30:00Z';
const d = new Date(iso);
const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
check('formatJobStart: starts render as a local wall clock',
  formatJobStart(iso) === expected, `${formatJobStart(iso)} vs ${expected}`);
check('formatJobStart: a shifted time is a different clock reading',
  formatJobStart('2024-05-01T09:30:00Z') !== formatJobStart('2024-05-01T10:30:00Z'));
check('formatJobStart: absent or unparseable values hide the line',
  formatJobStart(null) === null && formatJobStart('') === null
    && formatJobStart('not a time') === null);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
