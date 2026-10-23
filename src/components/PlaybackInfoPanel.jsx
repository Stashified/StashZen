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
import { engineNoteFor } from '../utils/engineController.js';

const POLL_MS = 500;

export default function PlaybackInfoPanel({ media, video, sourceKind, src, engine, engineStatus }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    const read = () => {
      if (!media) return;
      setRows(playbackStats(media, {
        sceneId: video?.id,
        sourceKind,
        src,
        sceneDuration: video?.durationSeconds,
        engine,
        // Why Auto is not on AVPlay, appended to the Player row. Without it a
        // fallback is indistinguishable from a bug on the TV. Only a browser
        // row may carry it: when AVPlay refused a file it goes on to play the
        // transcode itself, and "AVPlay · AVPlay refused this format" reads
        // like a contradiction on the panel.
        engineNote: engine === 'avplay' ? '' : engineNoteFor(engineStatus),
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
    media, video?.id, video?.durationSeconds,
    video?.videoCodec, video?.audioCodec, video?.container,
    sourceKind, src, engine, engineStatus,
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
