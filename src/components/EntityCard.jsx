/**
 * EntityCard, one card for Tags, Studios, Galleries and Images.
 *
 * The sections differ, but the difference lives in the `view` descriptor
 * (title, subtitle, badge, image, aspect) rather than here, so the layout is
 * written once instead of four times.
 *
 * `onLongPress` is only wired when `view.longPress` asks: Images and Galleries
 * have a menu, Tags and Studios have nothing, and leaving those as plain taps
 * keeps their Enter firing on keydown.
 *
 * `onSelect` takes `(item, index, list)`: the Images viewer steps through the
 * listing and needs the position and the listing. Other sections ignore both;
 * `list` is `list?.items` here, and a section wanting the rest can ask later.
 */

import { memo, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './EntityCard.module.css';

/** One or two initials for when there is no picture: a failed load, since
 *  `image_path` is non-empty for every tag and studio, see tagService. */
function initialsOf(text) {
  return String(text || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0])
    .join('')
    .toUpperCase() || '?';
}

function EntityCard({
  item, index, list, onSelect, onLongPress, view,
  autoFocus = index === 0,
  // Only the Home shelf passes this, to send Up to the rail; undefined is the
  // spatial default.
  nextId = null,
  // Home fixes shelf cards to one height; `fill` drops the aspect ratio so the
  // cover takes that height. Listings pass nothing.
  fill = false,
}) {
  const [imgError, setImgError] = useState(false);

  // One closure for both Enter and click, so the two cannot drift apart.
  const select = () => onSelect?.(item, index, list?.items);
  // The whole listing: the menu's subtitle needs its total for "12 of 40".
  const longPress = () => onLongPress?.(item, index, list);

  const { ref, focused } = useFocusable({
    // The Carousel matches on this same prefix to know which slot the D-pad is
    // on; see carouselViews.js.
    id: `${view.focusPrefix}-${item.id}`,
    zone: 'grid',
    onEnter: select,
    onLongPress: view.longPress && onLongPress ? longPress : undefined,
    autoFocus,
    autoFocusWhenIdle: true,
    nextId,
  });

  const title = view.getTitle(item);
  const subtitle = view.getSubtitle?.(item) || null;
  const badge = view.getBadge?.(item) || null;
  const src = view.getImage(item);
  const landscape = view.aspect === 'landscape';

  return (
    <button
      ref={ref}
      className={`${styles.card} ${fill ? styles.fill : ''} ${focused ? styles.focused : ''}`}
      onClick={select}
      aria-label={view.label?.(item) || title}
    >
      <div className={`${styles.cover} ${landscape ? styles.landscape : ''}`}>
        {!imgError && src ? (
          <img
            src={src}
            alt=""
            className={styles.img}
            onError={() => setImgError(true)}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className={styles.imgFallback}>
            <span>{initialsOf(title)}</span>
          </div>
        )}

        {view.isFavorite?.(item) && (
          <div className={styles.favorite} aria-label="Favorite">★</div>
        )}

        <div className={styles.coverGradient} />

        <div className={styles.coverInfo}>
          <p className={styles.name}>{title}</p>
          {(subtitle || badge) && (
            <div className={styles.meta}>
              {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
              {badge && <span className={styles.rating}>{badge}</span>}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// Same reasoning as VideoCard: the grids and carousel pass a stable listing, so
// an append renders only the new cards.
export default memo(EntityCard);
