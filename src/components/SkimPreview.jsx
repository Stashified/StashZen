/**
 * SkimPreview, sprite-tile preview that follows the seek point.
 *
 * Renders the tile for `time` along the track at `progressPct` (0..100); the
 * caller shows/hides it. An off-screen <img> learns each sheet's natural size,
 * then the tile is cropped with background-size/position, avoiding
 * transform-scaling subpixel cracks and bleed.
 *
 * Stash returns `paths.sprite`/`paths.vtt` whether or not the files exist, and
 * coverage is partial. When the sheet 404s the tile stays a placeholder and the
 * bubble still shows the time; Generate → Sprites in Stash fills it in.
 *
 * `sheetSizeCache` is keyed by the full sprite URL, which encodes host and API
 * key, so it needs no data-source partitioning.
 */

import { useEffect, useState } from 'react';
import styles from './SkimPreview.module.css';
import { formatTime } from '../utils/format.js';

const TILE_DISPLAY_WIDTH = 200; // px on screen

// Natural dimensions per sprite URL
const sheetSizeCache = new Map(); // src → { w, h }

function useSheetSize(src) {
  const [size, setSize] = useState(() => sheetSizeCache.get(src) || null);

  useEffect(() => {
    if (!src) { setSize(null); return; }
    const cached = sheetSizeCache.get(src);
    if (cached) { setSize(cached); return; }

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      sheetSizeCache.set(src, dims);
      setSize(dims);
    };
    img.onerror = () => { if (!cancelled) setSize(null); };
    img.src = src;

    return () => { cancelled = true; };
  }, [src]);

  return size;
}

export default function SkimPreview({ cue, time, progressPct, visible }) {
  const sheetSize = useSheetSize(cue?.src);

  if (!cue || !visible) return null;

  const scale = TILE_DISPLAY_WIDTH / cue.w;
  const displayHeight = cue.h * scale;

  // background-size scales the sheet; background-position shifts the tile to
  // our box's (0,0).
  const tileStyle = sheetSize
    ? {
        width:  `${TILE_DISPLAY_WIDTH}px`,
        height: `${displayHeight}px`,
        backgroundImage:    `url("${cue.src}")`,
        backgroundSize:     `${sheetSize.w * scale}px ${sheetSize.h * scale}px`,
        backgroundPosition: `-${cue.x * scale}px -${cue.y * scale}px`,
        backgroundRepeat:   'no-repeat',
      }
    : {
        // Placeholder while the natural size loads, so layout doesn't jump
        width:  `${TILE_DISPLAY_WIDTH}px`,
        height: `${(TILE_DISPLAY_WIDTH * 9) / 16}px`,
        background: 'rgba(255,255,255,0.05)',
      };

  // Clamp so the bubble can't run off-screen; 6/94 leaves a small margin.
  const left = Math.max(6, Math.min(94, progressPct));

  return (
    <div
      className={styles.bubble}
      style={{ left: `${left}%` }}
      aria-hidden="true"
    >
      <div className={styles.tile} style={tileStyle} />
      <div className={styles.time}>{formatTime(time)}</div>
    </div>
  );
}
