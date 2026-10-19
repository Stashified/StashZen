/**
 * ItemList — one full-width row per item, for every listing tab.
 *
 * The fourth view mode, alongside Classic, Carousel and Coverflow. It is a
 * *listing* component in the same family as VideoGrid and EntityGrid, and it
 * deliberately keeps their contracts rather than inventing new ones:
 *
 *   - `usePagedList` owns paging; this component supplies the request and the
 *     same IntersectionObserver sentinel, observed from inside the scroller.
 *   - Focus ids are `${view.focusPrefix}-${item.id}` — exactly the ids the
 *     grids and the play queue already use. A list-specific prefix would break
 *     the queue, the check harness and every surface that looks a card up by
 *     id.
 *   - `role="grid"` on a one-column list is intentional. ARIA allows a grid to
 *     have any number of columns, and keeping the role means existing
 *     consumers (the harness's page helpers, anything that finds the listing
 *     by role) do not need a second branch.
 *
 * What the descriptor supplies is in `carouselViews.js` and `entityViews.jsx`:
 * the hero model for title/meta/badge (already written for the carousel), the
 * row's art field, and — the part that genuinely differs per section — the
 * argument list its activation uses. That last one is a descriptor function
 * (`rowSelect`) rather than a guess here, because scenes hand the *whole*
 * listing up (a play queue needs `fetchPage`) while entities hand
 * `(item, index, items)` to the image viewer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ListStats from './ListStats.jsx';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './ItemList.module.css';

const PAGE_SIZE = 40;

/** Mirrors EntityCard's fallback: one or two initials for rows with no art. */
function initialsOf(text) {
  return String(text || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0])
    .join('')
    .toUpperCase() || '?';
}

function Row({ item, index, list, onSelect, onLongPress, view }) {
  const [imgError, setImgError] = useState(false);

  // The hero model already separates a rating from the other meta fields
  // (`kind: 'rating'`), which is exactly the split a row needs: the rating is
  // the right-aligned badge, everything else is the muted meta line.
  const hero = view.hero(item);
  const meta = hero.meta || [];
  const title = hero.title || view.getTitle?.(item) || 'Untitled';
  const details = meta.filter(m => m.kind !== 'rating').map(m => m.text);
  const badge = meta.find(m => m.kind === 'rating')?.text || null;

  const src = view.rowImage ? view.rowImage(item) : view.getImage?.(item);
  const portrait = view.aspect === 'portrait';

  // One closure for Enter, click and long-press argument-building, so the
  // three cannot drift apart.
  const activate = () => {
    if (view.rowSelect) view.rowSelect(item, index, list, onSelect);
    else onSelect?.(item);
  };
  const longPress = view.rowLongPress
    ? () => view.rowLongPress(item, index, list, onLongPress)
    : undefined;

  const { ref, focused } = useFocusable({
    id: `${view.focusPrefix}-${item.id}`,
    zone: 'grid',
    onEnter: activate,
    onLongPress: longPress,
    autoFocus: index === 0,
    autoFocusWhenIdle: true,
  });

  return (
    <button
      ref={ref}
      className={`${styles.row} ${focused ? styles.focused : ''}`}
      onClick={activate}
      aria-label={view.label?.(item) || title}
    >
      <span className={`${styles.thumb} ${portrait ? styles.portrait : ''}`}>
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
          <span className={styles.fallback}>{initialsOf(title)}</span>
        )}
      </span>

      <span className={styles.body}>
        <span className={styles.title}>{title}</span>
        {details.length > 0 && (
          <span className={styles.meta}>{details.join(' · ')}</span>
        )}
      </span>

      {badge && <span className={styles.badge}>{badge}</span>}
    </button>
  );
}

export default function ItemList({ controls, view, objectFilter, searchQuery, onSelect, onLongPress }) {
  const { sort, order } = controls;
  const { service, itemsKey, noun, focusPrefix } = view;

  const fetchPage = useCallback(
    (page) =>
      service({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE })
        .then(d => ({ items: d[itemsKey], total: d.total })),
    [service, itemsKey, sort, order, objectFilter, searchQuery],
  );

  const {
    items, total, page, loading, loadingMore, error, exhausted, loadMore,
  } = usePagedList({
    fetchPage,
    // ← critical: sort and order MUST be in the key
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
  });

  // `fetchPage` is included even for sections whose select ignores it: the
  // scene queue reads it, and handing every row the same listing shape keeps
  // `rowSelect` from having to know which section it is in.
  const listing = { items, total, page, fetchPage };

  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { root, rootMargin: '400px 0px', threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  if (loading) return (
    <div className={styles.state}>
      <div className={styles.spinner} aria-label={`Loading ${noun}`} />
      <p className={styles.stateText}>Loading {noun}…</p>
    </div>
  );

  if (error && !items.length) return (
    <div className={styles.state}>
      <p className={styles.stateText} style={{ color: 'var(--red)' }}>Error: {error}</p>
    </div>
  );

  if (!items.length) return (
    <div className={styles.state}>
      <p className={styles.stateText}>No {noun} found.</p>
    </div>
  );

  return (
    <div className={styles.page}>
      <ListStats loaded={items.length} total={total} noun={noun} />
      <div className={styles.listWrapper} ref={scrollRef}>
        <div
          className={styles.list}
          role="grid"
          aria-label={`${noun} list`}
          data-list-mode=""
          data-focus-prefix={focusPrefix}
        >
          {items.map((item, i) => (
            <Row
              key={item.id}
              item={item}
              index={i}
              list={listing}
              onSelect={onSelect}
              onLongPress={onLongPress}
              view={view}
            />
          ))}
        </div>

        {!exhausted && (
          <div ref={sentinelRef} className={styles.sentinel}>
            {loadingMore && (
              <>
                <div className={styles.spinnerSm} />
                <span className={styles.loadingMoreText}>Loading more…</span>
              </>
            )}
            {error && !loadingMore && (
              <span className={styles.loadingMoreText} style={{ color: 'var(--red)' }}>
                Couldn't load more — {error}
              </span>
            )}
          </div>
        )}

        {exhausted && (
          <div className={styles.endMarker}>
            <span>{total.toLocaleString()} {noun} loaded</span>
          </div>
        )}
      </div>
    </div>
  );
}
