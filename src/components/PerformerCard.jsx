/**
 * PerformerCard — Cover image + name + scene count
 * Cover is portrait-oriented (3:4) — matches Stash's image_path.
 *
 * Takes its record as `item`, like every other card in the tree — the shared
 * name is what lets one container render any of them (`Carousel` does; see its
 * header).
 *
 * The portrait ratio is why this card needs a `--slot-w` of its own when the
 * carousel renders it: the strip's slot width and the hero's scale factor are
 * both sized for 16:9 landscape art. See Carousel.module.css.
 *
 * `autoFocus` defaults to "the first card in a grid", which is what every
 * listing wants. The Home shelf overrides it, because four shelves mount at
 * once and only the top one may claim focus — without the explicit `false`
 * this card's first instance would race the scene shelf for it. `nextId` is
 * the same explicit edge VideoCard takes, so the top shelf can hand Up to the
 * rail.
 */

import { useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './PerformerCard.module.css';

export default function PerformerCard({
  item, index, onSelect,
  autoFocus = index === 0,
  nextId = null,
  // Home gives every shelf card one fixed height; `fill` drops the 3:4 ratio
  // so the portrait cover takes that height instead of exceeding it. The
  // Performers grid and the carousel pass nothing and stay portrait.
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
