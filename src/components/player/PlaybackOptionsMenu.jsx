/**
 * PlaybackOptionsMenu, playback speed and transcode quality over the video.
 *
 * A dialog, like the queue panel: `role="dialog"` makes the player's key map
 * yield (foreignDialogOpen) and this component's Back handler closes it. One
 * zone and one column, so Up/Down walk the rows and Left/Right do nothing
 * accidental.
 *
 * The speed rows come from `media.capabilities.speedRates`, so the backend
 * decides what it can honour: the browser offers 0.5–2, AVPlay only 1 and 2.
 * Quality is the same setting as Settings > Transcode quality, and only a
 * transcoded source has tiers; the player re-sources it on selection.
 */

import { useEffect } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { useBackKey } from '../../hooks/useBackKey.js';
import { TRANSCODE_QUALITY_OPTIONS } from '../../utils/settings.js';
import styles from './PlaybackOptionsMenu.module.css';

const ZONE = 'player-options';

function OptionRow({ id, label, current, autoFocus, onSelect }) {
  const { ref, focused } = useFocusable({
    id,
    zone: ZONE,
    autoFocus,
    onEnter: onSelect,
  });

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused, ref]);

  return (
    <button
      ref={ref}
      type="button"
      role="menuitemradio"
      aria-checked={current ? 'true' : 'false'}
      className={[
        styles.row,
        current ? styles.current : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={onSelect}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.check} aria-hidden="true">{current ? '✓' : ''}</span>
    </button>
  );
}

export default function PlaybackOptionsMenu({
  speedRates = [1],
  speed = 1,
  quality = 'original',
  onSelectSpeed,
  onSelectQuality,
  onClose,
}) {
  useBackKey(() => onClose?.());

  const rates = (Array.isArray(speedRates) ? speedRates : [])
    .filter(r => Number.isFinite(Number(r)) && Number(r) > 0);
  const autoSpeed = rates.includes(speed) ? speed : rates[0] ?? 1;

  const chooseSpeed = (rate) => {
    onSelectSpeed?.(rate);
    onClose?.();
  };
  const chooseQuality = (value) => {
    onSelectQuality?.(value);
    onClose?.();
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Playback options"
      onClick={onClose}
    >
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <header className={styles.header}>
          <h2 className={styles.heading}>Playback options</h2>
        </header>

        <div className={styles.list} role="menu" aria-label="Playback options">
          <div className={styles.section} role="group" aria-label="Speed">
            <p className={styles.sectionLabel} aria-hidden="true">Speed</p>
            {rates.map(rate => (
              <OptionRow
                key={rate}
                id={`player-options-speed-${rate}`}
                label={`${rate}×`}
                current={rate === speed}
                autoFocus={rate === autoSpeed}
                onSelect={() => chooseSpeed(rate)}
              />
            ))}
          </div>

          <div className={styles.section} role="group" aria-label="Quality">
            <p className={styles.sectionLabel} aria-hidden="true">Quality</p>
            <p className={styles.sectionHint} aria-hidden="true">
              Transcoded scenes only
            </p>
            {TRANSCODE_QUALITY_OPTIONS.map(option => (
              <OptionRow
                key={option.value}
                id={`player-options-quality-${option.value}`}
                label={option.label}
                current={option.value === quality}
                onSelect={() => chooseQuality(option.value)}
              />
            ))}
          </div>
        </div>

        <p className={styles.hint}>
          <kbd>OK</kbd> select &nbsp;·&nbsp; <kbd>Back</kbd> close
        </p>
      </div>
    </div>
  );
}
