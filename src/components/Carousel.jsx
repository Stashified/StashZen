/**
 * Carousel — a centred strip of cards, one row deep.
 *
 * Layout: the focused card sits in the middle of the stage scaled up, with
 * partial neighbours receding to either side; Left/Right move focus and the
 * strip translates to keep the focused slot centred.
 *
 * It was `VideoCarousel` and knew about scenes in four separate places: the
 * service it called, the card it rendered, the `video-` focus-id prefix, and
 * the four scene fields it printed in the hero. Every one of those is now part
 * of the `view` descriptor, which is what lets the same component draw
 * performers and markers — see the three descriptors in carouselViews.js.
 *
 * The paging itself lives in usePagedList; this component supplies the request
 * and the trigger (the focused index nearing the end of the strip).
 *
 * ## What a `view` has to provide
 *
 *   Card        the card component. It must take `{ item, index, list,
 *               onSelect, onLongPress }` — the contract every card in the tree
 *               now shares, which is what makes this possible at all.
 *   service     the paged fetch, called as
 *               `service({ sort, order, filter, q, page, limit })`, returning
 *               `{ <itemsKey>, total }`.
 *   itemsKey    where the rows live in that response ('videos', 'performers'…).
 *   focusPrefix the cards' registry-id prefix ('video', 'performer'…). This is
 *               how the strip learns which slot the D-pad is on, so it has to
 *               match what the card passes to `useFocusable`. It is kept
 *               separate from `Card` rather than read off it because the prefix
 *               is also the app's cross-cutting id scheme — App parses it to
 *               decide what a selection means.
 *   noun        plural, for the loading and empty strings.
 *   ariaLabel   for the strip's `role="region"`.
 *   hero        `(item) => ({ title, meta })`, where each meta entry is
 *               `{ text, kind }` and `kind` is 'tag' | 'rating' | undefined.
 *               Fields, not markup: the strip owns how a tag or a rating
 *               looks, the page owns which fields a section has.
 *   slotWidth   optional px width for one slot, when the section's art is not
 *               16:9. See the note on `--slot-w` in Carousel.module.css.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { getCurrentFocusId } from '../hooks/useFocusable.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './Carousel.module.css';

const PAGE_SIZE = 40;
const LOAD_MORE_THRESHOLD = 8; // fetch more when focus is within N of end

export default function Carousel({
  controls, objectFilter, searchQuery, view, onSelect, onLongPress,
}) {
  const { sort, order } = controls;
  const { Card, service, itemsKey, focusPrefix, noun, ariaLabel, hero, slotWidth } = view;

  const [focusedIndex, setFocusedIndex] = useState(0);

  // Named, not inline: the play queue is handed the same closure, so a
  // queue started here pages the listing the carousel is showing.
  const fetchPage = useCallback(
    (page) =>
      service({ sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE })
        .then(d => ({ items: d[itemsKey], total: d.total })),
    [service, itemsKey, sort, order, objectFilter, searchQuery],
  );

  const {
    items, total, page, loading, loadingMore, error, loadMore,
  } = usePagedList({
    fetchPage,
    // A new request identity resets the list, and the focus along with it.
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
  });

  const listing = useMemo(
    () => ({ items, total, page, fetchPage }),
    [items, total, page, fetchPage],
  );

  // Reset the focused slot when the list underneath is replaced — otherwise
  // the strip would try to centre an index that no longer exists.
  useEffect(() => { setFocusedIndex(0); }, [sort, order, objectFilter, searchQuery]);

  // ── Fetch more when focus approaches the end ──────────────
  useEffect(() => {
    if (items.length === 0) return;
    if (items.length - focusedIndex <= LOAD_MORE_THRESHOLD) loadMore();
  }, [focusedIndex, items.length, loadMore]);

  // ── Track which card is focused ───────────────────────────
  // Cards register with id `${focusPrefix}-${id}` in zone `grid`; the D-pad
  // moves focus itself, so this listens for the result rather than driving it.
  const idPrefix = `${focusPrefix}-`;
  useEffect(() => {
    const onFocus = () => {
      const fid = getCurrentFocusId();
      if (!fid || !fid.startsWith(idPrefix)) return;
      const id = fid.slice(idPrefix.length);
      const idx = items.findIndex(v => String(v.id) === String(id));
      if (idx >= 0 && idx !== focusedIndex) setFocusedIndex(idx);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [items, focusedIndex, idPrefix]);

  // ── Render ────────────────────────────────────────────────
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

  // Each slot is a fixed width; the strip translates so the focused
  // slot is centered. CSS handles the visual scaling for off-center
  // cards via the depth indices on `.slot`.
  const focused = items[focusedIndex] || items[0];
  const { title, meta = [], blurb = null } = hero(focused);

  return (
    <div
      className={styles.carouselWrapper}
      style={slotWidth ? { '--slot-w': `${slotWidth}px` } : undefined}
    >
      {/* Hero info above the strip — title, meta, position */}
      <div className={styles.hero}>
        <h2 className={styles.heroTitle}>{title}</h2>
        <div className={styles.heroMeta}>
          {meta.map((m, i) => (
            <span
              key={i}
              className={m.kind === 'tag' ? styles.heroTag
                : m.kind === 'rating' ? styles.heroRating
                  : undefined}
            >
              {m.text}
            </span>
          ))}
        </div>
        {/* A tag description or studio details can be paragraphs. The CSS
            clamps this to two lines, which is what keeps the strip's height
            from depending on the focused row. */}
        {blurb && <p className={styles.heroBlurb}>{blurb}</p>}
        <div className={styles.heroCounter}>
          <span className={styles.heroCounterCur}>{focusedIndex + 1}</span>
          <span className={styles.heroCounterSep}>/</span>
          <span className={styles.heroCounterTotal}>{total || items.length}</span>
        </div>
      </div>

      {/* The strip — shifted so the focused slot lands in the middle */}
      <div className={styles.stage} role="region" aria-label={ariaLabel}>
        <div
          className={styles.track}
          style={{
            // The track is positioned with `left: 50%` in CSS so its
            // origin sits at the centre of the stage. We then shift it
            // left by (focusedIndex + 0.5) slot widths so the focused
            // slot's centre lands on the stage centre.
            transform: `translateX(calc(-1 * ${focusedIndex + 0.5} * var(--slot-w)))`,
          }}
        >
          {items.map((item, i) => {
            const offset = i - focusedIndex;
            const abs = Math.abs(offset);
            // Cards more than 4 away aren't worth rendering — they're
            // off-screen anyway and would just hold preview videos open
            const visible = abs <= 4;
            return (
              <div
                key={item.id}
                className={styles.slot}
                data-offset={offset}
                style={{
                  // Fade and shrink as we move away from center
                  opacity: visible ? Math.max(0.2, 1 - abs * 0.2) : 0,
                  transform: `scale(${i === focusedIndex ? 2 : 0.82})`,
                  zIndex: 100 - abs,
                }}
                aria-hidden={i !== focusedIndex}
              >
                {visible && (
                  <Card
                    item={item}
                    index={i}
                    list={listing}
                    onSelect={onSelect}
                    onLongPress={onLongPress}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Subtle loading indicator if pagination is in flight */}
      {loadingMore && (
        <div className={styles.loadingMore}>
          <div className={styles.spinnerSm} />
          <span>Loading more…</span>
        </div>
      )}

      {error && !loadingMore && items.length > 0 && (
        <div className={styles.loadingMore} style={{ color: 'var(--red)' }}>
          <span>Couldn't load more — {error}</span>
        </div>
      )}
    </div>
  );
}
