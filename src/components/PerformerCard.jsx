/**
 * PerformerCard — cover image + name + scene count, portrait (3:4) to match
 * Stash's `image_path`.
 *
 * Takes its record as `item`, like every card, so one container can render any
 * of them (`Carousel` does).
 *
 * The portrait ratio needs a `--slot-w` of its own in the carousel, whose slot
 * width and hero scale assume 16:9. See Carousel.module.css.
 *
 * `autoFocus` defaults to the first card, which every listing wants. The Home
 * shelf overrides it to `false`: four shelves mount at once and only the top
 * may claim focus. `nextId` lets the top shelf hand Up to the rail.
 */

import { useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './PerformerCard.module.css';

export default function PerformerCard({
  item, index, onSelect,
  autoFocus = index === 0,
  nextId = null,
  // Home fixes shelf card heights; `fill` drops the 3:4 ratio so the cover
  // takes that height. Grids and the carousel stay portrait.
  fill = false,
}) {
  const [imgError, setImgError] = useState(false);

  const { ref, focused } = useFocusable({
    id: `performer-${item.id}`,
    zone: 'grid',
    onEnter: () => onSelect?.(item),
    autoFocus,
    autoFocusWhenIdle: true,
    nextId,
  });

  const initials = item.name
    ?.split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0])
    .join('')
    .toUpperCase() || '?';

  return (
    <button
      ref={ref}
      className={`${styles.card} ${fill ? styles.fill : ''} ${focused ? styles.focused : ''}`}
      onClick={() => onSelect?.(item)}
      aria-label={`${item.name}, ${item.scene_count} scenes`}
    >
      <div className={styles.cover}>
        {!imgError && item.image_path ? (
          <img
            src={item.image_path}
            alt=""
            className={styles.img}
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className={styles.imgFallback}>
            <span>{initials}</span>
          </div>
        )}

        {item.favorite && (
          <div className={styles.favorite} aria-label="Favorite">★</div>
        )}

        <div className={styles.coverGradient} />

        <div className={styles.coverInfo}>
          <p className={styles.name}>{item.name}</p>
          <div className={styles.meta}>
            <span className={styles.sceneCount}>{item.scene_count} scenes</span>
            {item.rating && (
              <span className={styles.rating}>★ {item.rating}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
