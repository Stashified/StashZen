/**
 * EntityCard — one card for Tags, Studios, Galleries and Images.
 *
 * The four sections genuinely differ (a Tag has no rating at all, a Studio has
 * one, a Gallery has a cover and an Image has a thumbnail), but none of that
 * difference lives here: the card asks its `view` descriptor for a title, a
 * subtitle, a badge and an image, and lays them out the same way. Eight bespoke
 * components would have re-derived this layout four times over and drifted.
 *
 * The descriptor carries a CSS class choice rather than the component knowing
 * which section it is in — `aspect` is the one thing that changes the *shape*
 * of the card, and it is a property of the art rather than of the section.
 *
 * `onLongPress` is part of the shared card contract (Carousel passes it) and is
 * deliberately ignored: the long-press menu is a scene action — Play, Play all,
 * Details — and none of those mean anything for a tag. It is not accepted as a
 * prop here rather than accepted-and-dropped, so the omission is visible.
 *
 * ## What `onSelect` is called with
 *
 * `(item, index, list)` — three arguments where the other cards in the tree
 * pass one. The Images section needs the other two: its selection opens a viewer
 * that steps through the listing, so it has to know where in the listing the
 * press happened and what the listing was. Tag, Studio and Gallery activation
 * ignores both. `list` is whatever the view handed down (`{ items, total }`
 * from a grid, the full listing object from a Carousel), so the third argument
 * is left as `list?.items` — a section that wants the rest can ask later.
 */

import { useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './EntityCard.module.css';

/** One or two initials, for when there is no picture. `image_path` is a
 *  non-empty string for every tag and studio in this library, so this is
 *  reached by a failed load rather than by a missing field — see tagService. */
function initialsOf(text) {
  return String(text || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0])
    .join('')
    .toUpperCase() || '?';
}

export default function EntityCard({
  item, index, list, onSelect, view,
  autoFocus = index === 0,
  // The same explicit edge VideoCard takes. Only the Home shelf passes one:
  // it lets the top visible shelf send Up to the rail. Every existing caller
  // leaves it undefined, which is the spatial default.
  nextId = null,
  // Home fixes every shelf card to one height; `fill` drops the descriptor's
  // aspect ratio so the cover takes that height. Listings pass nothing.
  fill = false,
}) {
  const [imgError, setImgError] = useState(false);

  // One closure for both the Enter key and the click, so the two cannot drift
  // apart — see the note on the argument list above.
  const select = () => onSelect?.(item, index, list?.items);

  const { ref, focused } = useFocusable({
    // The prefix comes from the descriptor, not from the component: it is also
    // the id scheme the Carousel matches on to know which slot the D-pad is on,
    // so the two have to agree. See the note in carouselViews.js.
    id: `${view.focusPrefix}-${item.id}`,
    zone: 'grid',
    onEnter: select,
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
