/**
 * playbackStats — the rows behind the player's "Playback info" panel.
 *
 * A readout for problems otherwise invisible from the sofa: slow start,
 * stutter, unskippable seeks, a timeline disagreeing with the scene's length.
 * Each is a property of the stream — direct or transcode, container,
 * resolution, buffer, seekability — and none is visible elsewhere in the UI.
 *
 * Two rules govern the rows.
 *
 * **The URL is shown by path only.** Direct and transcoded streams carry
 * `?apikey=…` (see playbackSource.js), so the full URL is a credential and
 * this panel is meant to be photographed for bug reports. `pathOf` strips the
 * query and fragment.
 *
 * **A value the element cannot supply is shown as `—`, not a plausible
 * default.** `duration` is NaN/Infinity for exactly the streams this panel
 * diagnoses, and `videoWidth` is 0 for audio; coercing either would hide the
 * discrepancy. The scene's own duration is a separate row because disagreement
 * *is* the finding.
 *
 * Rows are data so the rules — especially credential-stripping — are testable
 * without a media element.
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
 * **This is what keeps the API key out of the panel.** Stash attaches
 * `?apikey=…` to transcodes, and a relative `/scene/1/stream` has no origin to
 * discard; both come back as the path alone.
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
 * Which of the shapes this is, from its path. `MP4` means Stash's streamed MP4
 * transcode; the scene's own file is served from `/stream` with no extension
 * unless remuxed — the ordinary direct case, read as `file`.
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
 * Two spellings, because Tizen's engine and modern Chromium disagree:
 * `getVideoPlaybackQuality()` is standard, `webkitDecodedFrameCount` is what
 * Chromium 56 on this TV exposes. A dropped count on a stuttering scene is the
 * whole diagnosis.
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
 * `sourceKind` is the resolver's answer, not inferred from the URL: only the
 * candidate that produced the source knows whether the server is re-encoding.
 * `codecs` describes the scene's *file*, worth keeping separate from what the
 * element plays when a transcode has replaced it.
 */
export function playbackStats(el, {
  sceneId, sourceKind, src, sceneDuration, codecs = {},
  engine = 'html5', engineNote = '',
} = {}) {
  if (!el) return [];

  const rows = [];
  const add = (label, value) => rows.push([label, value]);
  const time = (s) => formatTime(s, { padMinutes: true });
  const reduced = engine === 'avplay';

  const kind = sourceKind === 'transcode' ? 'Transcoded'
    : sourceKind === 'direct' ? 'Direct play'
      : 'Resolving…';
  add('Source', `${kind} · ${sourceFormat(src)}`);
  if (sceneId != null) add('Scene', String(sceneId));

  // Which engine plays, and under Auto why it is not the requested one
  // (AVPlay unavailable, content refused, session kill switch). The caller
  // derives the note; this row reports it.
  add('Player', `${reduced ? 'AVPlay' : 'Browser'}${engineNote ? ` · ${engineNote}` : ''}`);

  // The AVPlay backend has no answer for these, and a placeholder would read
  // as a measurement. They are left out rather than printed as `—`.
  if (!reduced) {
    const w = finite(el.videoWidth) || 0;
    const h = finite(el.videoHeight) || 0;
    add('Resolution', w > 0 && h > 0 ? `${w}×${h}` : '—');
  }

  const streamSeconds = finite(el.duration);
  add('Stream duration',
    streamSeconds != null && streamSeconds > 0 ? time(streamSeconds) : '—');
  const sceneSeconds = finite(sceneDuration);
  if (sceneSeconds != null && sceneSeconds > 0) add('Scene duration', time(sceneSeconds));

  add('Position', time(finite(el.currentTime) ?? 0));

  // A seek that keeps throwing is survivable (the coalescer degrades), but
  // "skims do nothing" is otherwise unreadable. Only shown while happening.
  if (el.seekDegraded) add('Seek', 'degraded — seeks are failing');

  if (!reduced) {
    const ahead = bufferedAhead(el);
    add('Buffer ahead', ahead == null ? '—' : `${ahead.toFixed(1)} s`);

    const seek = seekableRange(el);
    add('Seekable', seek ? `${time(seek.start)} – ${time(seek.end)}` : '—');

    const ready = READY_LABEL[el.readyState] ?? `#${el.readyState}`;
    const network = NETWORK_LABEL[el.networkState] ?? `#${el.networkState}`;
    add('Engine', `${ready} · ${network}`);

    const frames = frameCounts(el);
    add('Frames', frames ? `${frames.total} · dropped ${frames.dropped}` : '—');
  }

  const volume = Math.round((finite(el.volume) ?? 0) * 100);
  const rate = finite(el.playbackRate);
  // TV mute is system-wide and has no readable level; the facade reports the
  // requested state. A panel with neither `tvaudiocontrol` nor `setVolume` has
  // no mute at all, so say "unavailable" rather than "not muted". An object
  // not advertising a capability predates this rule — report what it does.
  const muteCapability = el.getMuteCapability?.() ?? 'property';
  add('Volume', muteCapability === 'none'
    ? 'unavailable'
    : reduced
      ? (el.muted ? 'muted (TV)' : 'not muted')
      : `${volume}%${el.muted ? ' · muted' : ''}`
        + (rate != null && rate !== 1 ? ` · ${rate}×` : ''));

  const codecLine = [codecs.videoCodec, codecs.audioCodec, codecs.container]
    .filter(Boolean).join(' / ');
  if (codecLine) add('File codecs', codecLine);

  if (el.error) add('Media error', MEDIA_ERROR[el.error.code] || `code ${el.error.code}`);

  if (src) add('Path', pathOf(src));
  return rows;
}
