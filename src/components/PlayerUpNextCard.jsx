/**
 * PlayerUpNextCard, the offer shown over the last half minute of a scene.
 *
 * A picture of what comes next and the one decision it invites: play it now,
 * or put the card away. Hiding only dismisses this scene's card; the queue
 * still advances when the scene ends. Not the queue drawer (PlayerQueuePanel),
 * which stays the place to jump around or drop rows.
 *
 * It takes the cursor when it appears, so the remote answers Play now and Hide
 * at once (the player focuses it, once per scene). While it is up it is the
 * only stop: the controls behind it are hidden and no key raises them. ←/→ walk
 * the two buttons, Enter activates one, ↓ steps to the next scene, and Back
 * puts the card away like Hide does.
 *
 * The countdown is when the scene ends by itself. It reads whole seconds from
 * the player's clock, so the text changes once a second, not on every tick.
 */

import { useSyncExternalStore } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { durationText } from './player/sceneMeta.js';
import styles from './PlayerUpNextCard.module.css';

const ZONE = 'up-next';

function CardButton({ id, label, primary, onEnter }) {
  const { ref, focused } = useFocusable({ id, zone: ZONE, onEnter });
  return (
    <button
      ref={ref}
      type="button"
      className={[styles.btn, primary ? styles.primary : '', focused ? styles.focused : ''].join(' ')}
      onClick={onEnter}
    >
      {label}
    </button>
  );
}

export default function PlayerUpNextCard({ item, onPlay, onHide, clock }) {
  const duration = durationText(item);
  const secondsLeft = useSyncExternalStore(clock.subscribeSecondsLeft, clock.getSecondsLeft);

  return (
    <div className={styles.card} data-up-next="" role="group" aria-label="Up next">
      <div className={styles.header}>
        <span className={styles.label}>Up next</span>
        {secondsLeft > 0 && (
          <span className={styles.countdown}>{`Next in ${secondsLeft} s`}</span>
        )}
      </div>
      <div className={styles.body}>
        {item.thumbnail
          ? <img className={styles.thumb} src={item.thumbnail} alt="" />
          : <span className={styles.thumbFallback}>{item.title?.[0] || '?'}</span>}
        <span className={styles.text}>
          <span className={styles.title}>{item.title}</span>
          {duration && <span className={styles.meta}>{duration}</span>}
        </span>
      </div>
      <div className={styles.actions}>
        <CardButton id="upnext-play" label="Play now" primary onEnter={onPlay} />
        <CardButton id="upnext-hide" label="Hide" onEnter={onHide} />
      </div>
    </div>
  );
}
