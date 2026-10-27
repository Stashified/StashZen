/**
 * Carousel, a centred strip of cards, one row deep.
 *
 * The focused card sits in the middle of the stage scaled up, with partial
 * neighbours receding either side; Left/Right move focus and the strip
 * translates to keep the focused slot centred. Paging lives in usePagedList;
 * this component supplies the request and the trigger (focus nearing the end).
 *
 * ## What a `view` has to provide
 *
 *   Card        must take `{ item, index, list, onSelect, onLongPress }`, the
 *               contract every card in the tree shares.
 *   service     `service({ sort, order, filter, q, page, limit, hero })` →
 *               `{ <itemsKey>, total }`. `hero: true` asks for the heavier
 *               query carrying the blurb; services without one ignore it.
 *   itemsKey    where the rows live ('videos', 'performers'…).
 *   focusPrefix the cards' registry-id prefix. The strip learns its slot from
 *               it, so it must match what the card passes to `useFocusable`;
 *               it is separate from `Card` because App also parses it to decide
 *               what a selection means.
 *   noun        plural, for the loading and empty strings.
 *   ariaLabel   for the strip's `role="region"`.
 *   hero        `(item) => ({ title, meta })`, each meta entry `{ text, kind }`
 *               with kind 'tag' | 'rating' | undefined. Fields, not markup: the
 *               strip owns how a tag looks, the page owns which fields exist.
 *   slotWidth   optional px slot width when the art is not 16:9. See `--slot-w`
 *               in Carousel.module.css.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useStableListing } from '../hooks/useStableListing.js';
import ListingState from './ListingState.jsx';
import { getCurrentFocusId } from '../hooks/useFocusable.js';
import { usePagedList } from '../hooks/usePagedList.js';
import { onFocusRestoreRequest } from '../utils/focus.js';
import { pageRequestKey } from '../utils/requestKey.js';
import styles from './Carousel.module.css';

const PAGE_SIZE = 40;
const LOAD_MORE_THRESHOLD = 8; // fetch more when focus is within N of end

export default function Carousel({
  controls, objectFilter, searchQuery, view, onSelect, onLongPress,
}) {
  const { sort, order } = controls;
  const { Card, service, itemsKey, focusPrefix, noun, ariaLabel, hero, slotWidth, entity } = view;

  const [focusedIndex, setFocusedIndex] = useState(0);

  // Named, not inline: the play queue gets the same closure, so a queue started
  // here pages the listing the carousel shows.
  const fetchPage = useCallback(
    (page, signal) =>
      service({
        sort, order, filter: objectFilter, q: searchQuery, page, limit: PAGE_SIZE,
        // The hero is the only consumer of the blurb.
        hero: true,
        signal,
      })
        .then(d => ({ items: d[itemsKey], total: d.total })),
    [service, itemsKey, sort, order, objectFilter, searchQuery],
  );

  const {
    items, total, page, loading, retrying, loadingMore, error, loadMore,
  } = usePagedList({
    fetchPage,
    // A new request identity resets the list and the focus with it.
    requestKey: pageRequestKey(sort, order, objectFilter, searchQuery),
    focusPrefix,
    entity,
  });

  // Stable identity with current values (see useStableListing): every card gets
  // the same object, so an append must not replace it, only the new slot
  // should render.
  const listing = useStableListing({ items, total, page, fetchPage });

  // Reset the focused slot when the list is replaced, or the strip centres an
  // index that no longer exists.
  useEffect(() => { setFocusedIndex(0); }, [sort, order, objectFilter, searchQuery]);

  useEffect(() => {
    if (items.length === 0) return;
    if (items.length - focusedIndex <= LOAD_MORE_THRESHOLD) loadMore();
  }, [focusedIndex, items.length, loadMore]);

  // Cards register as `${focusPrefix}-${id}` in zone `grid`; the D-pad moves
  // focus itself, so listen for the result rather than driving it.
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

  // Only ±4 slots are mounted, so a restore to a card outside that window has
  // no element to find. Move the window when the request names one of ours:
  // on arrival if the rows are here, otherwise as soon as they land.
  const pendingRestoreRef = useRef(null);
  useEffect(() => onFocusRestoreRequest((fid) => {
    if (!fid) { pendingRestoreRef.current = null; return; }
    if (!fid.startsWith(idPrefix)) return;
    pendingRestoreRef.current = fid;
    const id = fid.slice(idPrefix.length);
    const idx = items.findIndex(v => String(v.id) === String(id));
    if (idx >= 0) {
      pendingRestoreRef.current = null;
      setFocusedIndex(idx);
    }
  }), [idPrefix, items]);

  useEffect(() => {
    const fid = pendingRestoreRef.current;
    if (!fid || !items.length) return;
    const id = fid.slice(idPrefix.length);
    const idx = items.findIndex(v => String(v.id) === String(id));
    if (idx < 0) return;
    pendingRestoreRef.current = null;
    setFocusedIndex(idx);
  }, [items, idPrefix]);

  if (loading) return (
    <ListingState
      id={`state-${noun}`}
      styles={styles}
      loading
      spinnerLabel={`Loading ${noun}`}
      text={retrying ? 'Connection problem, retrying…' : `Loading ${noun}…`}
    />
  );

  if (error && !items.length) return (
    <ListingState id={`state-${noun}`} styles={styles} error text={`Error: ${error}`} />
  );

  if (!items.length) return (
    <ListingState id={`state-${noun}`} styles={styles} text={`No ${noun} found.`} />
  );

  // Fixed-width slots; the strip translates to centre the focused one, and CSS
  // scales the off-centre cards via the depth indices.
  const focused = items[focusedIndex] || items[0];
  const { title, meta = [], blurb = null } = hero(focused);

  return (
    <div
      className={styles.carouselWrapper}
      style={slotWidth ? { '--slot-w': `${slotWidth}px` } : undefined}
    >
      {/* Hero info above the strip */}
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
        {/* Clamped to two lines in CSS, which keeps the strip's height from
            depending on the focused row. */}
        {blurb && <p className={styles.heroBlurb}>{blurb}</p>}
        <div className={styles.heroCounter}>
          <span className={styles.heroCounterCur}>{focusedIndex + 1}</span>
          <span className={styles.heroCounterSep}>/</span>
          <span className={styles.heroCounterTotal}>{total || items.length}</span>
        </div>
      </div>

      {/* The strip, shifted so the focused slot lands in the middle */}
      <div className={styles.stage} role="region" aria-label={ariaLabel}>
        <div
          className={styles.track}
          style={{
            // The track's origin is the stage centre (`left: 50%`), so shift
            // left by (focusedIndex + 0.5) slots to centre the focused one.
            transform: `translateX(calc(-1 * ${focusedIndex + 0.5} * var(--slot-w)))`,
          }}
        >
          {items.map((item, i) => {
            const offset = i - focusedIndex;
            const abs = Math.abs(offset);
            // Beyond 4 away is off-screen and would only hold preview videos
            // open.
            const visible = abs <= 4;
            return (
              <div
                key={item.id}
                className={styles.slot}
                data-offset={offset}
                style={{
                  // Fade and shrink with distance from centre.
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

      {/* Pagination in flight */}
      {loadingMore && (
        <div className={styles.loadingMore}>
          <div className={styles.spinnerSm} />
          <span>Loading more…</span>
        </div>
      )}

      {error && !loadingMore && items.length > 0 && (
        <div className={styles.loadingMore} style={{ color: 'var(--red)' }}>
          <span>Couldn't load more: {error}</span>
        </div>
      )}
    </div>
  );
}
