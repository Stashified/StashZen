#!/usr/bin/env node
/**
 * test-playback-stats.mjs — the stats readout, and what it must not print
 *
 *   node scripts/test-playback-stats.mjs
 *
 * Two load-bearing rules. The panel is meant to be photographed for a bug
 * report, so it must never print a media URL's query string — every Stash
 * transcode carries `?apikey=…`. And AVPlay cannot answer buffer, seekable,
 * readyState, frame or resolution questions, so those rows are omitted rather
 * than filled with placeholders that look like measurements.
 */

import {
  playbackStats,
  pathOf,
  sourceFormat,
} from '../src/utils/playbackStats.js';

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

const rowsToObject = (rows) => Object.fromEntries(rows);
const has = (row, label) => Object.prototype.hasOwnProperty.call(row, label);

// A fake element with every property the full row set reads.
function fakeEl() {
  const buffered = { length: 1, start: () => 0, end: () => 142.4 };
  const seekable = { length: 1, start: () => 0, end: () => 1827.2 };
  return {
    currentTime: 42,
    duration: 1827.24,
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: 4,
    networkState: 1,
    volume: 0.5,
    muted: true,
    playbackRate: 1,
    error: null,
    buffered,
    seekable,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 900, droppedVideoFrames: 3 }),
  };
}

const SRC = 'https://stash.local:8087/scene/1957/stream.m3u8?apikey=SECRETKEY';
const base = {
  sceneId: 1957,
  sourceKind: 'transcode',
  src: SRC,
  sceneDuration: 1827,
  codecs: { videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' },
};

// ── Credential hygiene ──────────────────────────────────────
check('pathOf drops the query string', pathOf(SRC) === '/scene/1957/stream.m3u8');
check('pathOf drops a fragment',
  pathOf('http://x/a.mp4?apikey=k#t=3') === '/a.mp4');
check('pathOf keeps a relative path', pathOf('/scene/1/stream?apikey=k') === '/scene/1/stream');
check('sourceFormat: HLS', sourceFormat(SRC) === 'HLS');
check('sourceFormat: MP4', sourceFormat('/scene/1/stream.mp4?x=1') === 'MP4');
check('sourceFormat: WebM', sourceFormat('/x.mp4.webm') === 'WebM');
check('sourceFormat: direct file', sourceFormat('/scene/1/stream?x=1') === 'file');

// ── Browser rows: the full set ─────────────────────────────
{
  const rows = playbackStats(fakeEl(), base);
  const row = rowsToObject(rows);
  check('browser: source names the transcode', row.Source === 'Transcoded · HLS');
  check('browser: scene id', row.Scene === '1957');
  check('browser: player is Browser', row.Player === 'Browser');
  check('browser: resolution', row.Resolution === '1920×1080');
  check('browser: stream duration', row['Stream duration'] === '30:27');
  check('browser: scene duration', row['Scene duration'] === '30:27');
  check('browser: position', row.Position === '00:42');
  check('browser: buffer ahead', row['Buffer ahead'] === '100.4 s');
  check('browser: seekable', row.Seekable === '00:00 – 30:27');
  check('browser: element state', row.Engine === 'enough data · idle');
  check('browser: frames', row.Frames === '900 · dropped 3');
  check('browser: volume', row.Volume === '50% · muted');
  check('browser: codecs', row['File codecs'] === 'h264 / aac / mp4');
  check('browser: path without the key', row.Path === '/scene/1957/stream.m3u8');
  check('no row contains the API key',
    rows.every(([, value]) => !String(value).includes('SECRETKEY')));
}

// ── AVPlay rows: reduced, and honest about it ──────────────
{
  const rows = playbackStats(fakeEl(), {
    ...base,
    engine: 'avplay',
    engineNote: 'content refused',
  });
  const row = rowsToObject(rows);
  check('avplay: player names the engine and the fallback reason',
    row.Player === 'AVPlay · content refused');
  check('avplay: resolution is not invented', !has(row, 'Resolution'));
  check('avplay: buffer ahead is not invented', !has(row, 'Buffer ahead'));
  check('avplay: seekable is not invented', !has(row, 'Seekable'));
  check('avplay: element enums are not invented', !has(row, 'Engine'));
  check('avplay: frames are not invented', !has(row, 'Frames'));
  check('avplay: duration is still reported', row['Stream duration'] === '30:27');
  check('avplay: position is still reported', row.Position === '00:42');
  check('avplay: mute says it is TV-level', row.Volume === 'muted (TV)');
  check('avplay: path is still reported', row.Path === '/scene/1957/stream.m3u8');
}

// ── A panel with no mute path says so ──────────────────────
{
  const el = { ...fakeEl(), getMuteCapability: () => 'none' };
  const row = rowsToObject(playbackStats(el, { ...base, engine: 'avplay' }));
  check('a panel with no mute capability reports it', row.Volume === 'unavailable');
}

// ── A degraded seek is a row while it lasts ────────────────
{
  const healthy = rowsToObject(playbackStats(fakeEl(), base));
  check('no Seek row while seeks work', !has(healthy, 'Seek'));
  const degraded = { ...fakeEl(), seekDegraded: true };
  const row = rowsToObject(playbackStats(degraded, base));
  check('a degraded seek is reported', /degraded/.test(row.Seek || ''));
}

// ── No source → empty, and no throw ────────────────────────
check('no media means no rows', playbackStats(null).length === 0);
check('no source shows Resolving', rowsToObject(playbackStats(fakeEl(), {})).Source === 'Resolving… · file');

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
