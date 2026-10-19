/**
 * PlaybackInfoPanel — the "stats for nerds" readout, toggled from the rail.
 *
 * Owns its own polling rather than taking rows from the player. The rows are
 * live — buffer, position and frame counts all move — and putting the 500ms
 * tick here keeps that re-render to this panel instead of the player, the
 * rail and everything else under it.
 *
 * Deliberately outside `.controls` in VideoPlayer, so it survives the rail
 * hiding itself: it is a readout the user turned on, not part of the
 * transport. Nothing inside it is focusable, so it adds no D-pad stop.
 *
 * `role="group"` rather than `status`: a live region at 2Hz would narrate the
 * buffer level to a screen reader forever. The values are the user's to read
 * when they want them.
 */

import { useEffect, useState } from 'react';
import styles from './PlaybackInfoPanel.module.css';
import { playbackStats } from '../utils/playbackStats.js';

const POLL_MS = 500;

export default function PlaybackInfoPanel({ videoRef, video, sourceKind, src }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    const read = () => {
      const el = videoRef.current;
      if (!el) return;
      setRows(playbackStats(el, {
        sceneId: video?.id,
        sourceKind,
        src,
        sceneDuration: video?.durationSeconds,
        codecs: {
          videoCodec: video?.videoCodec,
          audioCodec: video?.audioCodec,
          container: video?.container,
        },
      }));
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
    // The scene fields are primitives, so the timer is rebuilt only when the
    // thing being described actually changes — not on every queue object
    // identity the player happens to hand over.
  }, [
    videoRef, video?.id, video?.durationSeconds,
    video?.videoCodec, video?.audioCodec, video?.container,
    sourceKind, src,
  ]);

  return (
    <div className={styles.panel} role="group" aria-label="Playback info">
      <p className={styles.title}>Playback info</p>
      {rows.map(([label, value]) => (
        <div key={label} className={styles.row}>
          <span className={styles.label}>{label}</span>
          <span className={styles.value}>{value}</span>
        </div>
      ))}
    </div>
  );
}
