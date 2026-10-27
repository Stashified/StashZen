/**
 * PlaybackInfoPanel, the "stats for nerds" readout, toggled from the rail.
 *
 * Owns its own 500 ms polling so the re-render stays in this panel rather than
 * the player and everything under it.
 *
 * Outside `.controls` in VideoPlayer so it survives the rail hiding: it is a
 * readout the user turned on, not part of the transport. Nothing inside is
 * focusable, so it adds no D-pad stop.
 *
 * `role="group"`, not `status`: a live region at 2Hz would narrate the buffer
 * to a screen reader forever.
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
        // Why Auto is not on AVPlay. Only a browser row carries it: AVPlay
        // falls back to the transcode itself, and "AVPlay refused this format"
        // on an AVPlay row would contradict itself.
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
    // Primitive fields only, so the timer is not rebuilt on every queue object
    // identity the player hands over.
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
