/**
 * playbackStats — the rows behind the player's "Playback info" panel.
 *
 * A readout for the one class of problem this app cannot otherwise explain
 * from the sofa: a scene that starts slowly, stutters, cannot be skimmed, or
 * shows a timeline that disagrees with its length. Every one of those is a
 * property of the stream — direct file or transcode, container, resolution,
 * how far ahead the buffer runs, whether the source is seekable — and none of
 * it is visible anywhere in the UI.
 *
 * Two rules govern what goes in a row.
 *
 * **The URL is shown by path only.** A direct stream and every transcode
 * arrive carrying `?apikey=…` (see playbackSource.js), so the full URL is a
 * credential, and a panel designed to be photographed for a bug report is the
 * last place to put one. `pathOf` strips the query and fragment, and the
 * checks pin that down.
 *
 * **A value the element cannot supply is shown as `—`, not as a plausible
 * default.** `duration` is `NaN` or `Infinity` for exactly the streams this
 * panel exists to diagnose, and `videoWidth` is 0 for audio, so coercing
 * either to 0 or to the scene's metadata would hide the discrepancy rather
 * than report it. The scene's own duration is a separate row for the same
 * reason: when the two disagree, that disagreement *is* the finding.
 *
 * The rows are built as data rather than rendered directly so that the rules
 * — and especially the credential-stripping rule — are testable without a
 * media element.
 */

import { formatTime } from './format.js';

// Media element state enums, spelled out because the numeric values are what
// the API reports and a bare `3` says nothing in a bug report.
const READY_LABEL = [
  'nothing loaded', 'metadata', 'current data', 'future data', 'enough data',
];
const NETWORK_LABEL = ['empty', 'idle', 'loading', 'no source'];
const MEDIA_ERROR = {
  1: 'aborted', 2: 'network', 3: 'decode', 4: 'unsupported',
};

const finite = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);

/**
 * The path of a media URL, with the query and fragment removed.
 *
 * **This is the function that keeps the API key out of the panel.** Stash
 * hands transcodes over with `?apikey=…` already attached, and a relative
 * `/scene/1/stream` has no origin to discard; both cases come back as the
 * path alone.
 */
export function pathOf(src) {
  const s = String(src || '');
  const cut = s.split('?')[0].split('#')[0];
  try {
    return new URL(cut).pathname;
  } catch {
    return cut;
  }
}

/**
 * Which of the shapes this is, from its path. `MP4` here means Stash's
 * streamed MP4 transcode; the scene's own file is served from `/stream` with
 * no extension unless it has been remuxed, which is the ordinary direct case
 * and reads as `file`.
 */
export function sourceFormat(src) {
  const path = pathOf(src).toLowerCase();
  if (path.endsWith('.m3u8')) return 'HLS';
  if (path.endsWith('.mp4')) return 'MP4';
  if (path.endsWith('.webm')) return 'WebM';
  if (path.endsWith('.mkv')) return 'MKV';
  return 'file';
}

/** Seconds of media buffered from the current position, or null. */
export function bufferedAhead(el) {
  try {
    const b = el?.buffered;
    if (!b || !b.length) return null;
    const t = Number(el.currentTime) || 0;
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) <= t + 0.001 && b.end(i) >= t) return Math.max(0, b.end(i) - t);
    }
    // The playhead can sit in a gap between ranges; the nearest one behind it
    // is the honest answer, and it is what the stall that made this interesting
    // will have left behind.
    return Math.max(0, b.end(b.length - 1) - t);
  } catch {
    return null;
  }
}

/** The seekable range, first start to last end, or null. */
export function seekableRange(el) {
  try {
    const s = el?.seekable;
    if (!s || !s.length) return null;
    return { start: s.start(0), end: s.end(s.length - 1) };
  } catch {
    return null;
  }
}

/**
 * Decoded and dropped frame counts.
 *
 * Two spellings, because the Tizen engine and modern Chromium disagree:
 * `getVideoPlaybackQuality()` is the standard one and `webkitDecodedFrameCount`
 * is what Chromium 56 on this TV exposes. Either is worth reporting; a dropped
 * count on a stuttering scene is the whole diagnosis.
 */
export function frameCounts(el) {
  try {
    const q = el?.getVideoPlaybackQuality?.();
    if (q && Number.isFinite(q.totalVideoFrames)) {
      return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames || 0 };
    }
  } catch {
    // Fall through to the legacy properties.
  }
  if (Number.isFinite(el?.webkitDecodedFrameCount)) {
    return { total: el.webkitDecodedFrameCount, dropped: el.webkitDroppedFrameCount || 0 };
  }
  return null;
}

/**
 * The panel's rows, as `[label, value]` pairs.
 *
 * `sourceKind` is the resolver's answer, not an inference from the URL: only
 * the candidate that produced the source knows whether the server is
 * re-encoding. `codecs` describes the scene's *file*, which is worth keeping
 * separate from what the element is playing when a transcode has replaced it.
 */
export function playbackStats(el, {
  sceneId, sourceKind, src, sceneDuration, codecs = {},
} = {}) {
  if (!el) return [];

  const rows = [];
  const add = (label, value) => rows.push([label, value]);
  const time = (s) => formatTime(s, { padMinutes: true });

  const kind = sourceKind === 'transcode' ? 'Transcoded'
    : sourceKind === 'direct' ? 'Direct play'
      : 'Resolving…';
  add('Source', `${kind} · ${sourceFormat(src)}`);
  if (sceneId != null) add('Scene', String(sceneId));

  const w = finite(el.videoWidth) || 0;
  const h = finite(el.videoHeight) || 0;
  add('Resolution', w > 0 && h > 0 ? `${w}×${h}` : '—');

  const streamSeconds = finite(el.duration);
  add('Stream duration',
    streamSeconds != null && streamSeconds > 0 ? time(streamSeconds) : '—');
  const sceneSeconds = finite(sceneDuration);
  if (sceneSeconds != null && sceneSeconds > 0) add('Scene duration', time(sceneSeconds));

  add('Position', time(finite(el.currentTime) ?? 0));

  const ahead = bufferedAhead(el);
  add('Buffer ahead', ahead == null ? '—' : `${ahead.toFixed(1)} s`);

  const seek = seekableRange(el);
  add('Seekable', seek ? `${time(seek.start)} – ${time(seek.end)}` : '—');

  const ready = READY_LABEL[el.readyState] ?? `#${el.readyState}`;
  const network = NETWORK_LABEL[el.networkState] ?? `#${el.networkState}`;
  add('Engine', `${ready} · ${network}`);

  const frames = frameCounts(el);
  add('Frames', frames ? `${frames.total} · dropped ${frames.dropped}` : '—');

  const volume = Math.round((finite(el.volume) ?? 0) * 100);
  const rate = finite(el.playbackRate);
  add('Volume', `${volume}%${el.muted ? ' · muted' : ''}`
    + (rate != null && rate !== 1 ? ` · ${rate}×` : ''));

  const codecLine = [codecs.videoCodec, codecs.audioCodec, codecs.container]
    .filter(Boolean).join(' / ');
  if (codecLine) add('File codecs', codecLine);

  if (el.error) add('Media error', MEDIA_ERROR[el.error.code] || `code ${el.error.code}`);

  if (src) add('Path', pathOf(src));
  return rows;
}
