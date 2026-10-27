/**
 * ShowroomRow, one shelf: a heading, up to five cards, and a See-all tile.
 *
 * The cards are the app's real cards, not showroom variants: focus ids, preview
 * behaviour, long-press menu and selection path are unchanged. The four shelves
 * draw the four card families (VideoCard, EntityCard + STUDIO_VIEW,
 * PerformerCard, EntityCard + GALLERY_VIEW), and the scene shelf uses its own
 * `focusIdPrefix` so shelf cards stay distinct from the listing's `video-` ids.
 *
 * The See-all tile is the sixth strip item, in zone 'grid' like the cards, and
 * deliberately not `verticalOnly`: Right past the fifth card must reach it.
 *
 * `isTop` means "the first shelf that actually renders", not the first row in
 * the table, an empty shelf hands the rail edge and autofocus to the next one.
 *
 * Every card sits in `.cell`, which owns the shelf's one height (see
 * ShowroomPage.module.css), and gets `fill` so its cover takes what is left:
 * that is what makes a portrait performer and a landscape studio card occupy
 * the same box. The See-all tile is unwrapped: it stretches to the row height,
 * and the harness looks for it as the strip's last element.
 */

import { useMemo } from 'react';
import VideoCard from './VideoCard.jsx';
import EntityCard from './EntityCard.jsx';
import PerformerCard from './PerformerCard.jsx';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from '../pages/ShowroomPage.module.css';

// Module constant, not a render literal: a fresh `nextId` object each render
// would defeat the memoized cards and re-render every shelf.
const TOP_EDGE = { up: 'nav-home' };

function SeeAllTile({ row, onSelect, nextId }) {
  const { ref, focused } = useFocusable({
    id: row.seeAllFocusId,
    zone: 'grid',
    onEnter: () => onSelect?.(row),
    nextId,
  });

  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.seeAll} ${focused ? styles.seeAllFocused : ''}`}
      onClick={() => onSelect?.(row)}
      aria-label={`See all ${row.heading}`}
      data-see-all={row.key}
    >
      <span className={styles.seeAllArt} aria-hidden="true">
        <span className={styles.seeAllArrow}>→</span>
      </span>
      <span className={styles.seeAllInfo}>
        <span className={styles.seeAllTitle}>See all</span>
        <span className={styles.seeAllHint}>{row.heading}</span>
      </span>
    </button>
  );
}

export default function ShowroomRow({
  row, items, isTop, error,
  onVideoSelect, onVideoLongPress, onStudioSelect,
  onPerformerSelect, onGallerySelect, onSeeAll,
}) {
  // Before the empty-row return: hooks must run in the same order every render,
  // and an empty shelf is legitimate.
  //
  // What a card hands back on select/long-press. `fetchPage: null` is the
  // established "nowhere to extend into" marker (see `single()` in App.jsx), so
  // a shelf's "play all" queues the five scenes the user can see.
  //
  // `focusPrefix` names the card Back should return to. Shelf cards register as
  // `showroom-<shelf>-video-<id>`, so the default would send restore looking
  // for a `video-<id>` that does not exist and leave it polling until the
  // deadline. See usePlayback.
  const list = useMemo(
    () => ({
      items,
      total: items.length,
      page: 1,
      fetchPage: null,
      focusPrefix: row.focusIdPrefix,
    }),
    [items, row.focusIdPrefix],
  );

  // An empty row is not a shelf and not an error, a library with no galleries
  // legitimately has no gallery shelf, so it does not exist.
  //
  // A *failed* row must not take that same path, or a timeout looks like an
  // empty shelf: heading, cards and See-all vanish and the rest slides up with
  // no explanation. One inert line under the heading is the whole report, the
  // next move is back to a tab, which asks again.
  if (!items.length) {
    if (!error) return null;
    return (
      <section className={styles.row} data-showroom-row={row.key}>
        <h2 className={styles.rowTitle}>{row.heading}</h2>
        <p className={styles.rowError}>Couldn't load {row.heading}</p>
      </section>
    );
  }

  // Up out of the top shelf leaves for the rail's active row, mirroring Left.
  // Without the edge the geometry picks the *nearest* row above, Scenes, the
  // row the user is not on, one Down press from the wrong part of the rail.
  // Measured at 1920x1080 in showroom-entry's H11.
  const topEdge = isTop ? TOP_EDGE : null;

  return (
    <section className={styles.row} data-showroom-row={row.key}>
      <h2 className={styles.rowTitle}>{row.heading}</h2>
      <div className={styles.strip}>
        {row.kind === 'scene' && items.map((item, i) => (
          <div className={styles.cell} key={item.id}>
            <VideoCard
              item={item}
              index={i}
              list={list}
              focusIdPrefix={row.focusIdPrefix}
              fill
              // Only one card on Home may claim focus on mount, or all four
              // shelves race for it.
              autoFocus={isTop && i === 0}
              nextId={topEdge}
              onSelect={onVideoSelect}
              onLongPress={onVideoLongPress}
            />
          </div>
        ))}
        {row.kind === 'performer' && items.map((item, i) => (
          <div className={styles.cell} key={item.id}>
            <PerformerCard
              item={item}
              index={i}
              fill
              autoFocus={isTop && i === 0}
              nextId={topEdge}
              onSelect={(performer) => onPerformerSelect?.(performer)}
            />
          </div>
        ))}
        {(row.kind === 'studio' || row.kind === 'gallery') && items.map((item, i) => (
          <div className={styles.cell} key={item.id}>
            <EntityCard
              item={item}
              index={i}
              list={list}
              view={row.view}
              fill
              autoFocus={isTop && i === 0}
              nextId={topEdge}
              // EntityCard calls `(item, index, items)`; these wrap the app's
              // existing one-argument handlers.
              onSelect={row.kind === 'studio'
                ? (studio) => onStudioSelect?.(studio)
                : (gallery) => onGallerySelect?.(gallery)}
            />
          </div>
        ))}
        <SeeAllTile row={row} onSelect={onSeeAll} nextId={topEdge} />
      </div>
    </section>
  );
}
