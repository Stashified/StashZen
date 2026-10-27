/**
 * MarkerCard, Marker thumbnail.
 *
 * Enter plays the parent scene's full stream from the marker's `seconds`
 * (handled in App's onSelect). There is no focus preview video: those files
 * 404 here too (/scene/{id}/scene_marker/{id}/stream).
 *
 * Takes its record as `item`, like every card, so one container can render any
 * of them (`Carousel` does).
 *
 * The long press takes `(item, list, index)` like VideoCard's, because its menu
 * is built from the listing the marker was found in. See actionMenus.js.
 */

import { useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './MarkerCard.module.css';
import { formatTime } from '../utils/format.js';

export default function MarkerCard({ item, index, list, onSelect, onLongPress }) {
  const [imgError, setImgError] = useState(false);

  const { ref, focused } = useFocusable({
    id: `marker-${item.id}`,
    zone: 'grid',
    onEnter: () => onSelect?.(item),
    // Opt-in, like VideoCard's: without a handler the press stays a plain tap
    // and its short action runs on keydown.
    onLongPress: onLongPress ? () => onLongPress(item, list, index) : undefined,
    autoFocus: index === 0,
    autoFocusWhenIdle: true,
  });

  return (
    <button
      ref={ref}
      className={`${styles.card} ${focused ? styles.focused : ''}`}
      onClick={() => onSelect?.(item)}
      aria-label={`${item.title}, in ${item.scene.title} at ${formatTime(item.seconds)}`}
    >
      <div className={styles.thumb}>
        {!imgError && item.screenshot ? (
          <img
            src={item.screenshot}
            alt=""
            className={styles.img}
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className={styles.imgFallback}>
            <span>{item.title?.[0] || '?'}</span>
          </div>
        )}

        <div className={styles.overlay}>
          <div className={styles.playIcon}>▶</div>
        </div>

        <div className={styles.timestamp}>{formatTime(item.seconds)}</div>
        {item.primaryTag && (
          <div className={styles.tag}>{item.primaryTag}</div>
        )}
      </div>

      <div className={styles.info}>
        <p className={styles.title}>{item.title}</p>
        <p className={styles.scene}>{item.scene.title}</p>
      </div>
    </button>
  );
}
