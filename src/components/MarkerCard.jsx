/**
 * MarkerCard — Marker thumbnail.
 *
 * Activating (Enter) plays the parent scene's full stream from the marker's
 * own `seconds` (handled in App's onSelect).
 *
 * This card also used to fade in a preview video on focus — the marker's own
 * `stream`, i.e. Stash's generated marker-preview file. Dropped for the same
 * reason as VideoCard's: those files 404 here too
 * (/scene/{id}/scene_marker/{id}/stream), so the element never painted a frame.
 * It was less visible than the scene-card case because this card keeps its
 * screenshot rendered underneath rather than hiding it, but it was still an
 * empty <video> mounted over every focused marker.
 *
 * Takes its record as `item`, like every other card in the tree — the shared
 * name is what lets one container render any of them (`Carousel` does; see its
 * header). The marker-specific field names are unchanged.
 */

import { useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './MarkerCard.module.css';
import { formatTime } from '../utils/format.js';

export default function MarkerCard({ item, index, onSelect }) {
  const [imgError, setImgError] = useState(false);

  const { ref, focused } = useFocusable({
    id: `marker-${item.id}`,
    zone: 'grid',
    onEnter: () => onSelect?.(item),
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
