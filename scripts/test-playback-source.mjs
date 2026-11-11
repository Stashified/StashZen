#!/usr/bin/env node
/**
 * test-playback-source.mjs: the transcode tier choice and the speed clamp.
 *
 *   node scripts/test-playback-source.mjs
 *
 * These rules sit between the Settings toggle and the URL the player fetches,
 * and both fail silently when wrong: a bad tier shows a picture the TV can
 * decode at the wrong size, and a bad clamp reports a rate the engine never
 * honoured. Only the choice is testable off-device, so the choice is pinned.
 */

import { pickTranscodeUrls, clampSpeed } from '../src/utils/playbackSource.js';

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ENDPOINT = (mime, path, res) => ({
  mime_type: mime,
  url: `http://192.168.1.10:9999/scene/1957${path}?apikey=K`
    + (res ? `&resolution=${res}` : ''),
});

// The fourteen endpoints a live Stash 0.32 advertises, in its own order. The
// first two are not transcodes: the scene's own file and a matroska remux.
const HLS = 'application/vnd.apple.mpegurl';
const MP4 = 'video/mp4';
const WEBM = 'video/webm';
const REAL = [
  ENDPOINT(MP4, '/stream', null),
  ENDPOINT(MP4, '/stream.mkv', null),
  ENDPOINT(MP4, '/stream.mp4', 'ORIGINAL'),
  ENDPOINT(MP4, '/stream.mp4', 'STANDARD'),
  ENDPOINT(MP4, '/stream.mp4', 'LOW'),
  ENDPOINT(WEBM, '/stream.webm', 'ORIGINAL'),
  ENDPOINT(WEBM, '/stream.webm', 'STANDARD'),
  ENDPOINT(WEBM, '/stream.webm', 'LOW'),
  ENDPOINT(HLS, '/stream.m3u8', 'ORIGINAL'),
  ENDPOINT(HLS, '/stream.m3u8', 'STANDARD'),
  ENDPOINT(HLS, '/stream.m3u8', 'LOW'),
];
const chosen = (quality) => pickTranscodeUrls(REAL, quality).map((u) => u.match(/stream\.[a-z0-9]+/)[0]);
const label = (url, list = REAL) => list.find((e) => e.url === url)?.url ?? '(none)';

// ── One tier per quality, all three formats ───────────────
{
  check('original sends HLS, MP4 and WebM at ORIGINAL',
    eq(pickTranscodeUrls(REAL, 'original'), [REAL[8].url, REAL[2].url, REAL[5].url]),
    pickTranscodeUrls(REAL, 'original').map((u) => label(u)).join(', '));

  check('standard sends HLS, MP4 and WebM at STANDARD',
    eq(pickTranscodeUrls(REAL, 'standard'), [REAL[9].url, REAL[3].url, REAL[6].url]),
    pickTranscodeUrls(REAL, 'standard').map((u) => label(u)).join(', '));

  check('low sends HLS, MP4 and WebM at LOW',
    eq(pickTranscodeUrls(REAL, 'low'), [REAL[10].url, REAL[4].url, REAL[7].url]),
    pickTranscodeUrls(REAL, 'low').map((u) => label(u)).join(', '));

  check('the order stays HLS, MP4, WebM at every quality',
    eq(chosen('original'), ['stream.m3u8', 'stream.mp4', 'stream.webm'])
      && eq(chosen('standard'), ['stream.m3u8', 'stream.mp4', 'stream.webm'])
      && eq(chosen('low'), ['stream.m3u8', 'stream.mp4', 'stream.webm']));

  check('an unknown quality keeps the original rule',
    eq(pickTranscodeUrls(REAL, '4k'), pickTranscodeUrls(REAL, 'original'))
      && eq(pickTranscodeUrls(REAL), pickTranscodeUrls(REAL, 'original')));
}

// ── The original file and its remux are never offered ─────
{
  const every = ['original', 'standard', 'low']
    .flatMap((q) => pickTranscodeUrls(REAL, q));
  check('the direct file and the matroska remux are excluded at every quality',
    !every.includes(REAL[0].url) && !every.includes(REAL[1].url),
    `offered ${[...new Set(every)].map((u) => label(u)).join(', ')}`);

  // The ext filter is what does it: the direct row is labelled video/mp4.
  const onlyDirect = pickTranscodeUrls(REAL.slice(0, 2), 'standard');
  check('a server offering only the original and its remux yields nothing',
    onlyDirect.length === 0, `chose ${onlyDirect.map((u) => label(u)).join(', ') || '(none)'}`);

  // Probe the two filters separately: the mime filter has to reject DASH on an
  // mp4 URL, the extension filter on a video/mp4 mime.
  const mp4 = ENDPOINT(MP4, '/stream.mp4', 'STANDARD');
  // A distinct URL, or dropping the mime filter would return this row and its
  // URL would match mp4's, leaving the mime half unable to fail.
  const dashMime = { ...ENDPOINT('application/dash+xml', '/stream.mp4', 'STANDARD'), url: `${mp4.url}&probe=dash` };
  const dashExt = ENDPOINT(MP4, '/stream.mpd', 'STANDARD');
  const mimeProbe = [dashMime, mp4];
  const mimeKept = pickTranscodeUrls(mimeProbe, 'standard');
  const extKept = pickTranscodeUrls([dashExt], 'standard');
  check('DASH is not a candidate, mime and extension alike',
    eq(mimeKept, [mp4.url]) && extKept.length === 0,
    `mime: ${mimeKept.map((u) => label(u, mimeProbe)).join(', ') || '(none)'}; `
      + `extension: ${extKept.map((u) => label(u, [dashExt])).join(', ') || '(none)'}`);
}

// ── A missing tier falls back instead of losing the format ──
{
  const noStandard = REAL.filter((e) => !/resolution=STANDARD/.test(e.url));
  check('standard falls back to ORIGINAL when the server generates no STANDARD',
    eq(pickTranscodeUrls(noStandard, 'standard'), [REAL[8].url, REAL[2].url, REAL[5].url]),
    pickTranscodeUrls(noStandard, 'standard').map((u) => label(u)).join(', '));

  const noLow = REAL.filter((e) => !/resolution=LOW/.test(e.url));
  check('low falls back to STANDARD before ORIGINAL',
    eq(pickTranscodeUrls(noLow, 'low'), [REAL[9].url, REAL[3].url, REAL[6].url]),
    pickTranscodeUrls(noLow, 'low').map((u) => label(u)).join(', '));

  const onlyOriginal = REAL.filter((e) => /stream\.(m3u8|mp4|webm)\?/.test(e.url)
    && !/resolution=(STANDARD|LOW)/.test(e.url));
  check('low falls back to ORIGINAL when that is all there is',
    eq(pickTranscodeUrls(onlyOriginal, 'low'), [REAL[8].url, REAL[2].url, REAL[5].url]),
    pickTranscodeUrls(onlyOriginal, 'low').map((u) => label(u)).join(', '));

  const lowAndOriginal = REAL.filter((e) => !/resolution=STANDARD/.test(e.url));
  check('standard skips a LOW row for ORIGINAL, never the worst picture',
    pickTranscodeUrls(lowAndOriginal, 'standard').every((u) => !/resolution=LOW/.test(u)),
    pickTranscodeUrls(lowAndOriginal, 'standard').map((u) => label(u)).join(', '));

  // The last resort when every row is LOW: a small picture beats no picture.
  check('low still takes a LOW row when nothing else exists',
    pickTranscodeUrls([REAL[4]], 'standard')[0] === REAL[4].url);
}

// ── Where the tier is read from ───────────────────────────
{
  const lower = [{
    mime_type: MP4,
    url: 'http://x/scene/1/stream.mp4?apikey=K&resolution=standard',
  }];
  check('a lowercase resolution is the same tier',
    pickTranscodeUrls(lower, 'standard')[0] === lower[0].url);

  const encoded = [{
    mime_type: MP4,
    url: 'http://x/scene/1/stream.mp4?apikey=K&resolution=Stan%64ard',
  }];
  check('a percent-encoded resolution is decoded before matching',
    pickTranscodeUrls(encoded, 'standard')[0] === encoded[0].url);

  // A malformed escape used to throw out of pickTranscodeUrls; it must read as
  // an unusable tier and leave the real sibling to win.
  const malformed = [
    { mime_type: MP4, url: 'http://x/scene/1/stream.mp4?apikey=K&resolution=%ZZ' },
    ENDPOINT(MP4, '/stream.mp4', 'LOW'),
  ];
  check('a malformed resolution escape is skipped, not thrown',
    eq(pickTranscodeUrls(malformed, 'low'), [malformed[1].url]),
    pickTranscodeUrls(malformed, 'low').map((u) => label(u, malformed)).join(', '));

  // "low" in a filename or a title is not a tier; only the query parameter is.
  const named = [
    ENDPOINT(MP4, '/lowlights/stream.mp4', null),
    ENDPOINT(MP4, '/stream.mp4', 'LOW'),
  ];
  check('a path containing "low" is not read as the LOW tier',
    pickTranscodeUrls(named, 'standard')[0] === named[0].url,
    pickTranscodeUrls(named, 'standard').map((u) => u === named[0].url ? 'named' : 'low').join(', '));
  check('...while the real LOW row still wins for the low quality',
    pickTranscodeUrls(named, 'low')[0] === named[1].url);

  const params = [{
    mime_type: 'application/vnd.apple.mpegurl; charset=utf-8',
    url: 'http://x/scene/1/stream.m3u8?apikey=K&resolution=LOW',
  }];
  check('mime parameters do not hide the format',
    pickTranscodeUrls(params, 'low')[0] === params[0].url);
}

// ── One URL per format ────────────────────────────────────
{
  const dupes = [
    ENDPOINT(MP4, '/stream.mp4', 'STANDARD'),
    { ...ENDPOINT(MP4, '/stream.mp4', 'STANDARD'), url: 'http://x/scene/2/stream.mp4?resolution=STANDARD' },
    ENDPOINT(HLS, '/stream.m3u8', 'STANDARD'),
  ];
  const urls = pickTranscodeUrls(dupes, 'standard');
  check('duplicate rows at the chosen tier still yield one URL per format',
    urls.length === 2 && eq(urls, [dupes[2].url, dupes[0].url]),
    urls.map((u) => label(u, dupes)).join(', '));

  check('no endpoints at all is an empty list, not an error',
    pickTranscodeUrls([]).length === 0
      && pickTranscodeUrls(null).length === 0
      && pickTranscodeUrls(undefined).length === 0);
}

// ── clampSpeed: the nearest rate the engine can honour ────
{
  const BROWSER = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const AVPLAY = [1, 2];

  check('a rate the engine offers is returned unchanged',
    clampSpeed(1.5, BROWSER) === 1.5 && clampSpeed(0.5, BROWSER) === 0.5
      && clampSpeed(2, AVPLAY) === 2);
  check('a rate the engine does not offer maps to the nearest',
    clampSpeed(1.5, AVPLAY) === 1 && clampSpeed(1.6, AVPLAY) === 2
      && clampSpeed(0.6, BROWSER) === 0.5 && clampSpeed(0.9, BROWSER) === 1,
    `${clampSpeed(1.5, AVPLAY)}, ${clampSpeed(1.6, AVPLAY)}, ${clampSpeed(0.6, BROWSER)}, ${clampSpeed(0.9, BROWSER)}`);
  check('a tie prefers the slower rate',
    clampSpeed(1.5, [1, 2]) === 1 && clampSpeed(0.5, [1, 2]) === 1
      && clampSpeed(1.5, [2, 1]) === 1);
  check('a value beyond the ladder clamps to its end',
    clampSpeed(9, AVPLAY) === 2 && clampSpeed(0.1, AVPLAY) === 1);
  check('a numeric string is accepted',
    clampSpeed('2', AVPLAY) === 2 && clampSpeed('1.25', BROWSER) === 1.25);

  check('an empty or invalid ladder falls back to 1x',
    clampSpeed(2, []) === 1 && clampSpeed(2, null) === 1
      && clampSpeed(2, undefined) === 1);
  check('invalid entries are filtered out of the ladder',
    clampSpeed(2, [0, -1, 'x', NaN, Infinity, 2]) === 2
      && clampSpeed(1, [0, 2]) === 2,
    `${clampSpeed(2, [0, -1, 'x', NaN, Infinity, 2])}, ${clampSpeed(1, [0, 2])}`);

  check('a NaN rate prefers 1x when the engine offers it',
    clampSpeed(NaN, BROWSER) === 1 && clampSpeed(undefined, AVPLAY) === 1);
  // The non-1 rate is first so the two behaviours differ: falling back to the
  // ladder's first entry returns 2, while defaulting to 1x and clamping would
  // return 0.5.
  check('...and the first rate when it does not',
    clampSpeed(NaN, [2, 0.5]) === 2 && clampSpeed('fast', [2, 0.5]) === 2,
    `${clampSpeed(NaN, [2, 0.5])}, ${clampSpeed('fast', [2, 0.5])}`);
  check('the ladder\'s own values are returned, not the wanted input',
    Number.isFinite(clampSpeed(1.6, AVPLAY))
      && [1, 2].includes(clampSpeed(1.6, AVPLAY)));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
