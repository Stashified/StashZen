/**
 * Headless driver for playback of files the TV cannot decode.
 *
 * Written for one report from the sofa: "file with codec msmpeg4v3 doesn't
 * want to play on this app, possible to get it playing?" It is not one file —
 * this library holds 456 scenes in codecs no browser engine decodes (see
 * playbackSource.js for the census), and the fix is to play them through
 * Stash's transcoder instead of their own bytes.
 *
 * Two halves, because the feature has two halves and they fail differently:
 *
 *   K — the classification, which is pure and can be asserted exhaustively.
 *       A codec list is a table of judgements, and the risk is not that it is
 *       wrong in a way a test can see but that it is quietly *incomplete*;
 *       so the table is written out from the library's real census rather
 *       than from the examples that happened to be in the bug report.
 *
 *   I — the player, mounted against the fake endpoint. What is asserted is
 *       ultimately one thing — *which URL the element was pointed at* — plus
 *       whether it managed to load. That is deliberately the only observable
 *       used: a check written against the hook's state would pass on a build
 *       that decided correctly and then handed the element something else.
 *
 *   K6 — the timeline rule, which is here for a different reason: it is the
 *       one part of the second TV report that could not be reproduced
 *       off-device at all. See the note above those checks.
 *
 * The case the whole design turns on is I3/I5: a codec the engine *rejects*
 * raises an error, and a codec it merely never decodes raises nothing at all.
 * Only the second one needs the stall watchdog, and only a server that hangs
 * can produce it — hence `/hang/` in server.py.
 *
 * **What this driver cannot say.** Two things, and both are load-bearing:
 * whether the Tizen engine plays an HLS playlist (headless Firefox cannot, so
 * every HLS candidate here fails and the scene lands on the MP4 fallback), and
 * whether the TV's engine would have got the duration wrong in the first
 * place. The requests the player *makes* are observable and are asserted;
 * what the TV does with the answer is checked on the TV, by the user.
 */

import { createRoot } from 'react-dom/client';
import { useState, useEffect, useRef } from 'react';
import VideoPlayer from '../../src/components/VideoPlayer.jsx';
import { useKeyHandler } from '../../src/hooks/useKeyHandler.js';
import { setSettings } from '../../src/utils/settings.js';
import {
  needsTranscode, pickTranscodeUrls, timelineDuration,
} from '../../src/utils/playbackSource.js';
import {
  playbackStats, pathOf, sourceFormat, bufferedAhead, frameCounts, seekableRange,
} from '../../src/utils/playbackStats.js';

const PORT = window.__PORT__;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms = 5000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

// ── The fake endpoint's own bookkeeping ─────────────────────
const clearLog = () => fetch('/clear', { method: 'POST' });
const streamsFetches = () => fetch('/streamsfetches').then(r => r.json());
/** Every request for transcoded media this run, in order, as full paths. */
const streamFetches = () => fetch('/streamfetches').then(r => r.json());
const setMode = (patch) => fetch('/mode', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});

// ── The element ─────────────────────────────────────────────
const videoEl = () => document.querySelector('video');
/** The URL the element is really on, resolved — not what React was passed. */
const currentSrc = () => videoEl()?.src || '';
/**
 * The URL the element *accepted*, which is not the same as the one it was
 * given.
 *
 * `src` is the attribute; `currentSrc` is what the element resolved it to. On
 * its own that is *not* enough of a difference, which is what control 3
 * taught: a build that hands the element a list — a missing expansion in
 * runFrom — sets `src` to the array's stringified form, and the browser
 * resolves that faithfully into a URL whose commas are percent-encoded but
 * whose path still contains `…/stream.m3u8%2C…%2C/stream.mp4…`. So a check
 * written as `currentSrc.includes(path)` finds its path in the middle of it
 * and passes on a build where nothing loads at all.
 *
 * Hence the comma rejection, which is the artifact's signature rather than a
 * guess about it: every URL this harness produces is comma-free, and a single
 * source can never be more than one. Empty means "not on one addressable
 * source", which is what a check reading this is entitled to assume.
 */
const acceptedSrc = () => {
  const s = videoEl()?.currentSrc || '';
  return s.includes(',') ? '' : s;
};
const hasData = () => (videoEl()?.readyState ?? 0) >= 2;
const errorText = () => document.querySelector('[class*="errorState"]')?.textContent || '';

// ── The player's own readouts ───────────────────────────────
// The chip and the panel are asserted on their *text*, not on a class or a
// piece of component state: what the user reads is the feature.
const sourceChipText = () =>
  document.querySelector('[class*="sourceChip"]')?.textContent?.trim() || '';
const statsPanel = () =>
  document.querySelector('[role="group"][aria-label="Playback info"]');
const statsText = () => (statsPanel()?.textContent || '').replace(/\s+/g, ' ');
const toggleStats = () => {
  const btn = document.querySelector('button[aria-label="Playback info"]');
  if (btn) btn.click();
  return !!btn;
};

// The stall watchdog's own duration, duplicated rather than imported: a driver
// that read the hook's constant would keep passing if someone shortened it to
// nothing, and "it gives up at all" is the property under test.
const STALL_MS = 10000;

// ── Scenes ──────────────────────────────────────────────────
const at = (path) => `http://127.0.0.1:${PORT}${path}`;
const scene = (over) => ({
  id: '9100',
  title: 'VERIFY codec',
  stream: null,
  thumbnail: null,
  durationSeconds: 60,
  resume_time: 0,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  ...over,
});

function Harness() {
  useKeyHandler({ onBack: () => {} });
  const [mount, setMount] = useState(null);
  const genRef = useRef(0);

  useEffect(() => {
    window.__mountScene = (s) => {
      genRef.current += 1;
      setMount({ scene: s, gen: genRef.current });
    };
  }, []);

  if (!mount) return null;
  return (
    <VideoPlayer
      key={mount.gen}
      queue={{
        items: [mount.scene], total: 1, page: 1,
        startIndex: 0, startSeconds: 0, fetchPage: null,
      }}
      onClose={() => {}}
    />
  );
}

/** Mount the player on a scene and give its effects a moment to run. */
async function show(s) {
  window.__mountScene(s);
  await sleep(250);
}

// ── K: the classification ───────────────────────────────────
// Every codec this library actually contains, from the API's own tally.
const CODEC_CENSUS = [
  ['h264', false], ['av1', false], ['hevc', false], ['vp9', false],
  ['wmv2', true], ['wmv3', true], ['mpeg4', true], ['mpeg1video', true],
  ['mjpeg', true], ['indeo5', true], ['msmpeg4v3', true],
];

const CONTAINERS = [
  ['mp4', false], ['matroska', false], ['webm', false], ['mpegts', false],
  ['wmv', true], ['avi', true], ['mpeg', true], ['flv', true],
];

const AUDIO = [
  ['aac', false], ['mp3', false], ['opus', false], ['vorbis', false],
  ['wmav2', true], ['ac3', true], ['dts', true], ['mp1', true],
  ['', false], [null, false],
];

/**
 * The endpoints a live Stash advertises, in the server's own order.
 *
 * Captured from the real API on 2026-10-16 — all fourteen, because the two
 * that are *not* transcodes are the trap this table exists to catch. `Direct
 * stream` is the scene's own file and `MKV` is a remux of the same codecs;
 * both are labelled `video/mp4` and neither carries a `resolution`. A
 * resolver that filtered on mime type would pick `Direct stream` and hand the
 * element back the bytes it had just refused.
 */
const REAL = [
  ['Direct stream',       'video/mp4',                    '/stream',       null],
  ['MKV',                 'video/mp4',                    '/stream.mkv',   null],
  ['MP4',                 'video/mp4',                    '/stream.mp4',   'ORIGINAL'],
  ['MP4 Standard (480p)', 'video/mp4',                    '/stream.mp4',   'STANDARD'],
  ['MP4 Low (240p)',      'video/mp4',                    '/stream.mp4',   'LOW'],
  ['WEBM',                'video/webm',                   '/stream.webm',  'ORIGINAL'],
  ['WEBM Standard (480p)','video/webm',                   '/stream.webm',  'STANDARD'],
  ['WEBM Low (240p)',     'video/webm',                   '/stream.webm',  'LOW'],
  ['HLS',                 'application/vnd.apple.mpegurl','/stream.m3u8',  'ORIGINAL'],
  ['HLS Standard (480p)', 'application/vnd.apple.mpegurl','/stream.m3u8',  'STANDARD'],
  ['HLS Low (240p)',      'application/vnd.apple.mpegurl','/stream.m3u8',  'LOW'],
  ['DASH',                'application/dash+xml',         '/stream.mpd',   'ORIGINAL'],
  ['DASH Standard (480p)','application/dash+xml',         '/stream.mpd',   'STANDARD'],
  ['DASH Low (240p)',     'application/dash+xml',         '/stream.mpd',   'LOW'],
].map(([label, mime, path, res]) => ({
  url: `http://192.168.1.10:8087/scene/1957${path}?apikey=K&label=${encodeURIComponent(label)}`
     + (res ? `&resolution=${res}` : ''),
  mime_type: mime,
  label,
}));

/** The label behind a chosen URL, for a failure message a human can read. */
const labelOf = (url) => (url ? (REAL.find(e => e.url === url)?.label ?? url) : '(none)');

function checkClassification() {
  const bad = [];
  for (const [codec, want] of CODEC_CENSUS) {
    const got = needsTranscode({ videoCodec: codec, container: 'mp4', audioCodec: 'aac' });
    if (got !== want) bad.push(`${codec} → ${got}`);
  }
  check('K1 every video codec in the library is classified as intended',
    bad.length === 0, bad.join(', ') || `${CODEC_CENSUS.length} codecs`);

  const badC = [];
  for (const [container, want] of CONTAINERS) {
    const got = needsTranscode({ videoCodec: 'h264', container, audioCodec: 'aac' });
    if (got !== want) badC.push(`${container} → ${got}`);
  }
  check('K2 a container alone can disqualify an otherwise playable file',
    badC.length === 0, badC.join(', ') || `${CONTAINERS.length} containers`);

  const badA = [];
  for (const [audio, want] of AUDIO) {
    const got = needsTranscode({ videoCodec: 'h264', container: 'mp4', audioCodec: audio });
    if (got !== want) badA.push(`${audio || '(none)'} → ${got}`);
  }
  check('K3 an audio codec alone can disqualify an otherwise playable file',
    badA.length === 0, badA.join(', ') || `${AUDIO.length} audio codecs`);

  // The boundary that keeps 94% of the library off the transcoder. "Unknown"
  // and "known bad" are different answers, and collapsing them would send
  // every scene whose metadata went missing through ffmpeg.
  const unknown = needsTranscode({});
  const unknown2 = needsTranscode(undefined);
  check('K4 a file with no codec metadata is left on the direct path',
    unknown === false && unknown2 === false, `{} → ${unknown}, undefined → ${unknown2}`);

  // ── Which endpoint, and in what order ──
  // Identity against the real entries, not substrings: the trap this pins
  // down is choosing the *first* thing that looks like an MP4, and of the real
  // server's answers only the third is a transcode — the first is the scene's
  // own file under another name and the second a remux of the same codecs.
  //
  // These are the only checks that can pin the choice down, which is worth
  // knowing before deleting one for being redundant with I2. A filter on mime
  // type alone picks the wrong entry only when no ORIGINAL tier is offered;
  // the integration fixture has to offer one, because otherwise there is no
  // transcoded URL for playback to be observed through. So I2 passes on a
  // resolver that is subtly wrong, and these do not.
  //
  // HLS first is a *reversal* of this file's original order, made after
  // probing the live server (see playbackSource.js): the MP4 transcode is a
  // linear stream with no length and no byte-range support, so a scene played
  // through it has a timeline that stops at ten seconds and a transport that
  // cannot move. Ordering is the whole fix, hence the checks on positions and
  // not merely on membership — a list that contained the HLS URL anywhere
  // would play MP4 on the TV and look identical from here.
  const urls = pickTranscodeUrls(REAL);
  check('K5 the HLS playlist is preferred ahead of every MP4 transcode',
    urls[0] === REAL[8].url, `first is ${labelOf(urls[0])}`);

  check('K5 MP4 follows HLS as a fallback rather than being dropped',
    urls[1] === REAL[2].url, `second is ${labelOf(urls[1])}`);

  check('K5 WebM is the last resort rather than being ignored',
    urls[2] === REAL[5].url, `third is ${labelOf(urls[2])}`);

  check('K5 exactly one URL per format, so the walk cannot stall on duplicates',
    urls.length === 3, `${urls.length} urls: ${urls.map(labelOf).join(', ')}`);

  check('K5 the original file and its remux are never offered, despite `video/mp4`',
    !urls.includes(REAL[0].url) && !urls.includes(REAL[1].url),
    `offered ${urls.map(labelOf).join(', ')}`);

  const noTranscodes = pickTranscodeUrls(REAL.slice(0, 2));
  check('K5 a server offering only the original and its remux yields no transcode at all',
    noTranscodes.length === 0, `chose ${noTranscodes.map(labelOf).join(', ') || '(none)'}`);

  const noHls = pickTranscodeUrls(REAL.filter(e => !e.url.includes('/stream.m3u8')));
  check('K5 with no HLS offered, MP4 leads the walk',
    noHls[0] === REAL[2].url, `first is ${labelOf(noHls[0])}`);

  const onlyWebm = pickTranscodeUrls(REAL.filter(e => e.mime_type === 'video/webm'));
  check('K5 a server with only WebM still yields a playable candidate',
    onlyWebm.length === 1 && onlyWebm[0] === REAL[5].url,
    `chose ${onlyWebm.map(labelOf).join(', ') || '(none)'}`);

  const noOriginal = pickTranscodeUrls(REAL.filter(e => !/ORIGINAL/.test(e.url)));
  check('K5 a downscale is still better than nothing when no ORIGINAL exists',
    noOriginal[0] === REAL[9].url && noOriginal[1] === REAL[3].url,
    `chose ${noOriginal.map(labelOf).join(', ')}`);

  check('K5 a server with no endpoints at all yields no URLs',
    pickTranscodeUrls([]).length === 0
      && pickTranscodeUrls(null).length === 0
      && pickTranscodeUrls(undefined).length === 0,
    `[] → [${pickTranscodeUrls([]).join(', ')}]`);

  // ── The timeline ──
  //
  // The second report — "timeline only shows first 10 secs, video continues to
  // play past it" — cannot be reproduced here at all, which is why these are
  // assertions on the rule rather than on a rendering. Every source shape that
  // could plausibly defeat a duration measurement was tried against headless
  // Firefox (a fragmented MP4 with an empty `moov`, a live WebM with no
  // Duration element, an endless chunked stream that never closes) and the
  // engine reported the true duration for all of them, because it measures the
  // media instead of trusting the container. The TV's engine does not. So the
  // decision is isolated in `timelineDuration` and pinned here, and what the
  // TV does with the answer is checked by the user on the TV and nowhere else.
  const SCENE_S = 1827.24;   // the real msmpeg4v3 scene's own duration
  check('K6 an element that reports a real duration is believed',
    timelineDuration(1827.24, 9999) === 1827.24,
    `got ${timelineDuration(1827.24, 9999)}`);

  check('K6 an element that reports no duration falls back to the scene\'s',
    timelineDuration(0, SCENE_S) === SCENE_S,
    `got ${timelineDuration(0, SCENE_S)}`);

  check('K6 an unmeasurable stream\'s Infinity is rejected, not drawn as a bar',
    timelineDuration(Infinity, SCENE_S) === SCENE_S,
    `got ${timelineDuration(Infinity, SCENE_S)}`);

  check('K6 a NaN duration falls back to the scene\'s as well',
    timelineDuration(NaN, SCENE_S) === SCENE_S,
    `got ${timelineDuration(NaN, SCENE_S)}`);

  check('K6 nothing anywhere yields zero rather than NaN or Infinity',
    timelineDuration(0, 0) === 0 && timelineDuration(null, undefined) === 0
      && timelineDuration(Infinity, NaN) === 0,
    `${timelineDuration(0, 0)}, ${timelineDuration(null, undefined)}, `
    + `${timelineDuration(Infinity, NaN)}`);

  check('K6 a scene whose own duration is unknown keeps the element\'s',
    timelineDuration(42, 0) === 42, `got ${timelineDuration(42, 0)}`);

  // ── What the playback-info panel is allowed to print ──
  //
  // The credential rule is the one that has to be checked rather than merely
  // intended: every transcode URL arrives with `?apikey=…` (see
  // playbackSource.js), and this panel exists to be read aloud or photographed
  // into a bug report.
  const keyed = 'http://192.168.1.10:8087/scene/1957/stream.m3u8'
    + '?apikey=SECRET&resolution=ORIGINAL';
  check('K7 the panel path strips the query and fragment',
    pathOf(keyed) === '/scene/1957/stream.m3u8'
      && pathOf('/scene/1/stream?apikey=SECRET') === '/scene/1/stream',
    `${pathOf(keyed)} · ${pathOf('/scene/1/stream?apikey=SECRET')}`);

  check('K7 the format is read from the path, not the query',
    sourceFormat(keyed) === 'HLS'
      && sourceFormat('/scene/1/stream.mp4?resolution=LOW') === 'MP4'
      && sourceFormat('/scene/1/stream.webm') === 'WebM'
      && sourceFormat('/scene/1/stream') === 'file'
      && sourceFormat('/tone.wav') === 'file',
    [sourceFormat(keyed), sourceFormat('/scene/1/stream.mp4'),
      sourceFormat('/scene/1/stream.webm'), sourceFormat('/tone.wav')].join(', '));

  // A real MP4 transcode reports no usable duration — that is the TV bug this
  // panel exists to diagnose — so Infinity must stay "unknown" rather than
  // being coerced to a number or quietly replaced by the scene's metadata.
  const fakeEl = {
    videoWidth: 1920, videoHeight: 1080,
    duration: Infinity, currentTime: 10,
    readyState: 4, networkState: 2,
    volume: 0.5, muted: true, playbackRate: 1,
    buffered: { length: 1, start: () => 0, end: () => 18.4 },
    seekable: { length: 1, start: () => 0, end: () => 1827 },
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 900, droppedVideoFrames: 3 }),
    error: null,
  };
  const rows = playbackStats(fakeEl, {
    sceneId: '9102', sourceKind: 'transcode',
    src: 'http://host/scene/9102/stream.mp4?apikey=SECRET',
    sceneDuration: 1827,
    codecs: { videoCodec: 'msmpeg4v3', audioCodec: 'mp3', container: 'avi' },
  });
  const row = Object.fromEntries(rows);

  check('K7 the panel reports the source the resolver chose',
    row.Source === 'Transcoded · MP4', row.Source);
  check('K7 an unmeasurable stream duration stays unknown, not invented',
    row['Stream duration'] === '—' && row['Scene duration'] === '30:27',
    `${row['Stream duration']} · ${row['Scene duration']}`);
  check('K7 resolution, buffer and seekable range come from the element',
    row.Resolution === '1920×1080' && row['Buffer ahead'] === '8.4 s'
      && row.Seekable === '00:00 – 30:27',
    `${row.Resolution} · ${row['Buffer ahead']} · ${row.Seekable}`);
  check('K7 frames and volume are reported',
    row.Frames === '900 · dropped 3' && row.Volume === '50% · muted',
    `${row.Frames} · ${row.Volume}`);

  const allText = JSON.stringify(rows);
  check('K7 no row can carry the API key or any query string',
    !allText.includes('SECRET') && !allText.includes('apikey')
      && row.Path === '/scene/9102/stream.mp4',
    row.Path);

  // The frame API has two spellings — see frameCounts — and the TV's engine
  // has only the older one.
  const legacyFrames = frameCounts({
    webkitDecodedFrameCount: 500, webkitDroppedFrameCount: 2,
  });
  check('K7 the older frame counters are read when the standard API is absent',
    JSON.stringify(legacyFrames) === JSON.stringify({ total: 500, dropped: 2 })
      && frameCounts({}) === null,
    JSON.stringify(legacyFrames));

  check('K7 a missing element yields no rows rather than throwing',
    playbackStats(null).length === 0 && bufferedAhead(null) === null
      && seekableRange(null) === null,
    `${playbackStats(null).length} rows`);
}

// ── I: the player ───────────────────────────────────────────
async function runPlayer() {
  // ── I1: an ordinary file is untouched ────────────────────
  await setMode({ streams: 'ok' });
  await clearLog();
  await show(scene({
    id: '9101',
    stream: at('/tone9101.wav'),
    videoCodec: 'h264', audioCodec: 'aac', container: 'mp4',
  }));
  const played = await waitFor(hasData);
  const i1Fetches = await streamsFetches();
  check('I1 a file the TV can decode plays from its own URL',
    played && currentSrc().includes('/tone9101.wav'), currentSrc());
  check('I1 and no transcode is asked for at all',
    i1Fetches.length === 0, `sceneStreams calls: [${i1Fetches.join(',')}]`);

  check('I1 the controls say it is playing direct',
    sourceChipText() === 'Direct play', `chip="${sourceChipText()}"`);

  const openedStats = toggleStats();
  await sleep(400);
  const i1Panel = statsPanel();
  const i1Text = statsText();
  check('I1 the rail opens a playback-info readout',
    openedStats && !!i1Panel,
    openedStats ? (i1Panel ? 'panel present' : 'no panel') : 'button not found');
  check('I1 the readout names the source, the scene and the URL path',
    i1Text.includes('Direct play · file') && i1Text.includes('9101')
      && i1Text.includes('/tone9101.wav'),
    i1Text.slice(0, 140));
  check('I1 the readout is inert, so it adds no focus stop',
    !!i1Panel && i1Panel.querySelectorAll('button, a, [tabindex]').length === 0,
    `${i1Panel ? i1Panel.querySelectorAll('button, a, [tabindex]').length : 'no'} focusable`);
  toggleStats();
  await sleep(400);
  check('I1 the same button closes it again',
    !statsPanel(), statsPanel() ? 'still up' : 'closed');

  // ── I2: the reported bug ─────────────────────────────────
  // The direct URL here *works* — it is a playable WAV. That is the point: the
  // only thing wrong with this scene is its codec, so a build that goes direct
  // anyway would load it and pass any check that only asked "did it play".
  //
  // The second report — "timeline only shows first 10 secs" — changed what
  // this has to observe. The format the player reaches for first is now the
  // substance of the fix, and the element's final `src` cannot show it:
  // headless Firefox has no HLS support, so it refuses the playlist and the
  // scene lands on the MP4 fallback either way. **Whether HLS *plays* on the
  // TV is therefore the one claim in this release no off-device run can
  // make.** What is observable is the *order of the requests*, which is where
  // the preference actually lives, and that the candidate behind HLS rescued
  // the scene — the same degradation path a TV that dislikes HLS would take.
  await clearLog();
  await show(scene({
    id: '9102',
    stream: at('/tone9102.wav'),
    videoCodec: 'msmpeg4v3', audioCodec: 'mp3', container: 'avi',
  }));
  const i2Played = await waitFor(hasData, 8000);
  const i2Fetches = await streamFetches();
  const hlsAt = i2Fetches.findIndex(p => p.includes('stream.m3u8'));
  const mp4At = i2Fetches.findIndex(p => p.includes('stream.mp4'));
  check('I2 the player reaches for the HLS transcode before any MP4',
    hlsAt !== -1 && (mp4At === -1 || hlsAt < mp4At),
    `requests: [${i2Fetches.join(', ')}]`);

  const i2Src = acceptedSrc();
  check('I2 an msmpeg4v3 scene plays through Stash\'s transcoder',
    i2Played && /\/scene\/9102\/stream\.(m3u8|mp4)/.test(i2Src), i2Src);
  check('I2 and never loads the file it was told is unplayable',
    !i2Src.includes('tone9102.wav'), i2Src);
  check('I2 the transcoded URL keeps the API key the server sent with it',
    i2Src.includes('apikey=harness'), i2Src);

  // The chip is the user-facing half of the resolver's decision. It is read
  // here rather than asserted from hook state so a build that decides
  // correctly and renders the wrong word is caught.
  check('I2 the controls say the scene is being transcoded',
    sourceChipText() === 'Transcoded', `chip="${sourceChipText()}"`);

  toggleStats();
  await sleep(400);
  const i2Text = statsText();
  check('I2 the readout names the format the element actually took',
    i2Text.includes('Transcoded · MP4'), i2Text.slice(0, 140));
  check('I2 and never prints the credentials attached to the stream URL',
    i2Text.includes('/scene/9102/stream.mp4') && !/apikey|harness/i.test(i2Text),
    i2Text.slice(0, 140));
  toggleStats();
  await sleep(400);

  // ── I3: the reactive half ────────────────────────────────
  // Codec fine, file dead. Nothing about the metadata predicts this, which is
  // the case a codec list alone can never cover.
  await clearLog();
  await show(scene({
    id: '9103',
    stream: at('/scene/9103/missing'),
    videoCodec: 'h264', audioCodec: 'aac', container: 'mp4',
  }));
  const i3Played = await waitFor(hasData, 8000);
  check('I3 a scene whose file fails falls back to a transcode',
    i3Played && acceptedSrc().includes('/scene/9103/stream.mp4'), acceptedSrc());
  check('I3 and the user is never shown a failure for it',
    errorText() === '', errorText());

  // ── I4: nothing works, and it says so ────────────────────
  // Transcoding switched off, file dead, codec known-bad. The failure mode
  // this guards is the one the bug report describes — a screen that never
  // resolves and never explains itself.
  await setMode({ streams: 'empty' });
  await show(scene({
    id: '9104',
    stream: at('/scene/9104/missing'),
    videoCodec: 'wmv3', audioCodec: 'wmav2', container: 'wmv',
  }));
  const sawError = await waitFor(() => errorText() !== '', 5000);
  check('I4 when nothing can be played the failure is shown, not spun at',
    sawError, sawError ? errorText().slice(0, 60) : 'still buffering');
  check('I4 and it names the codec the user would have to convert',
    errorText().includes('wmv3'), errorText());
  await setMode({ streams: 'ok' });

  // ── I5: the silent failure ───────────────────────────────
  // A source that is accepted and then never decodes. No error event, ever —
  // the element simply sits there. This is what "doesn't want to play" looks
  // like from the sofa, and the watchdog is the only thing that can see it.
  await clearLog();
  await show(scene({
    id: '9105',
    stream: at('/hang/9105'),
    videoCodec: 'h264', audioCodec: 'aac', container: 'mp4',
  }));
  const stalledBefore = currentSrc();
  const rescued = await waitFor(() => acceptedSrc().includes('/scene/9105/stream.mp4'),
    STALL_MS + 9000);
  check('I5 a source that loads nothing and reports nothing is re-sourced',
    rescued, `was ${stalledBefore}, now ${acceptedSrc()}`);
  const i5Played = await waitFor(hasData, 4000);
  check('I5 and the scene plays after the switch',
    i5Played, `readyState ${videoEl()?.readyState}`);
  check('I5 the watchdog never mistook the stall for a failure',
    errorText() === '', errorText());

  // ── I6: a failure mid-play keeps the playhead ────────────
  //
  // The refusal this whole feature exists for can arrive *after* the file has
  // been playing — the element decodes until it reaches something it cannot
  // handle. Re-sourcing from scratch would drop the user back to 0:00 of a
  // scene they were a third of the way through. The playhead is the element's
  // own last timeupdate, so no resume prompt is involved either way.
  await setMode({ streams: 'ok' });
  await clearLog();
  await show(scene({
    id: '9106',
    stream: at('/tone9106.wav'),
    videoCodec: 'h264', audioCodec: 'aac', container: 'mp4',
  }));
  const beforeFailure = await waitFor(
    () => hasData() && videoEl() && videoEl().paused === false, 5000);
  const v6 = videoEl();
  // Forward seeks land only inside downloaded data, and this fake server has no
  // Range support: a seek past the buffered end is clamped back towards it.
  // Wait for the file to arrive, then seek.
  await waitFor(() => {
    const b = v6.buffered;
    return b.length > 0 && b.end(b.length - 1) >= 40;
  }, 5000);
  v6.currentTime = 25;
  const sought = await waitFor(() => Math.abs(v6.currentTime - 25) < 1, 2500);
  await sleep(300);            // a timeupdate carries 25 into the player's ref
  const preError = v6.currentTime;
  check('I6 setup: playback reached the middle of the scene',
    sought && preError > 20, `seeked=${sought} currentTime=${preError.toFixed(1)}`);

  // A real media failure: the guard reads `v.error`, not the event alone. The
  // override is removed immediately after dispatch — the handler runs
  // synchronously — so the injected error does not latch onto the element and
  // drive the *following* attempts.
  Object.defineProperty(v6, 'error', { configurable: true, value: { code: 4 } });
  v6.dispatchEvent(new Event('error'));
  delete v6.error;

  const refell = await waitFor(
    () => acceptedSrc().includes('/scene/9106/stream.mp4') && hasData(), 9000);
  await sleep(600);
  const at6 = videoEl()?.currentTime ?? 0;
  check('I6 a source that fails mid-play is replaced', beforeFailure && refell,
    `was ${at6.toFixed(1)}s when re-sourced: ${acceptedSrc()}`);
  // The threshold is deliberately not "≈25". This fake server answers without
  // `Accept-Ranges`, and Firefox clamps a forward seek to what the *new*
  // source has buffered when its metadata arrives — observed at ~17 s here.
  // The property under test is "the playhead was carried, not reloaded from
  // zero", and a build without it lands at ~0.6 s and stays there.
  check('I6 ...without losing the playhead',
    at6 >= 12, `currentTime=${at6.toFixed(1)}s after the fallback from ` +
    `${preError.toFixed(1)}s (forward seeks clamp to the fresh source's buffer; ` +
    'a reload from the start would report ~0.6)');
  check('I6 ...and the recovery is not reported as a failure',
    errorText() === '', errorText());

  // A chip that kept saying "Direct play" after the source was replaced would
  // be worse than no chip: it would answer the one question it exists for
  // with the wrong answer.
  check('I6 the source chip follows the fallback rather than sticking',
    sourceChipText() === 'Transcoded', `chip="${sourceChipText()}"`);

  // ── I7: play pressed before the transcode URL exists ─────
  //
  // A codec known-bad starts on the transcode, so the element has no `src`
  // for as long as sceneStreams takes. Pressing play in that window answers
  // NotSupportedError — a *state*, not a failure — and the old handler turned
  // it into a permanent "Failed to load video" over a scene that was about to
  // play underneath it.
  await setMode({ streams: 'slow' });
  await clearLog();
  await show(scene({
    id: '9107',
    stream: at('/tone9107.wav'),
    videoCodec: 'wmv3', audioCodec: 'wmav2', container: 'avi',
  }));
  // Pause first. The mount effect has already called `play()` on the
  // source-less element, which sets `paused` false even though its promise is
  // still pending — so Play (415) alone would be a no-op here, and the path
  // under test would never run. Pause is *not* a workaround, it is what a user
  // does when the screen sits black: 19 puts the element back to paused, and
  // the next 415 is the press that reaches `playQuietly`.
  const pressMedia = (key, keyCode) => window.dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
  pressMedia('MediaPause', 19);
  await sleep(80);
  const srcBeforePress = videoEl()?.src || '';
  pressMedia('MediaPlay', 415);
  let sawEarlyError = '';
  for (let i = 0; i < 24 && !sawEarlyError; i += 1) {
    await sleep(50);
    if (errorText() !== '') sawEarlyError = errorText();
  }
  check('I7 setup: the play press landed before any source existed',
    srcBeforePress === '', `element src "${srcBeforePress}"`);
  check('I7 play while the transcode is still resolving is not an error',
    sawEarlyError === '', sawEarlyError || 'no overlay through the wait');
  const i7Played = await waitFor(hasData, 8000);
  check('I7 ...and the scene plays once the URL arrives',
    i7Played && acceptedSrc().includes('/scene/9107/stream.mp4')
      && videoEl()?.paused === false,
    `${acceptedSrc()} paused=${videoEl()?.paused}`);
  await setMode({ streams: 'ok' });
}

setSettings({ useMock: false, stashUrl: `http://127.0.0.1:${PORT}`, stashKey: 'harness' });

createRoot(document.getElementById('root')).render(<Harness />);

async function run() {
  await sleep(600);
  checkClassification();
  await runPlayer();
}

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
    try {
      await fetch('/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(results, null, 2),
      });
      await fetch('/done', { method: 'POST' });
    } catch { /* nothing left to do */ }
  });
