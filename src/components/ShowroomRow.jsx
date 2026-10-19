/**
 * ShowroomRow — one shelf: a heading, up to five cards, and a See-all tile.
 *
 * The cards are the app's real cards, not showroom-only variants: the focus
 * ids, preview behaviour, long-press menu and selection path all stay exactly
 * what they are in a grid. The four shelves draw the four card families —
 * VideoCard (scene), EntityCard + STUDIO_VIEW, PerformerCard (portrait), and
 * EntityCard + GALLERY_VIEW — and the scene shelf uses its own focus-id prefix
 * (`focusIdPrefix`) so shelf cards are distinct from the numbered `video-` ids
 * of the Scenes listing. See the note on `focusIdPrefix` in VideoCard.
 *
 * The See-all tile is the sixth strip item, in zone 'grid' like the cards, and
 * is deliberately not `verticalOnly`: Right past the fifth card has to be able
 * to land on it.
 *
 * `isTop` is "this is the first shelf that actually renders", not the first
 * row in the table — an empty shelf hands both the rail edge and the single
 * autofocus down to the next one.
 *
 * Every card is wrapped in `.cell`, which owns the shelf's one height (see
 * ShowroomPage.module.css), and each card is passed `fill` so its cover takes
 * whatever the fixed height leaves. That is what makes a portrait performer
 * card and a landscape studio card occupy the same box. The See-all tile is
 * not wrapped: it already stretches to the row height, and the harness looks
 * for it as the strip's last element.
 */

import VideoCard from './VideoCard.jsx';
import EntityCard from './EntityCard.jsx';
import PerformerCard from './PerformerCard.jsx';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from '../pages/ShowroomPage.module.css';

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
  // A row with nothing in it is not a shelf. It is also not an error state:
  // a library with no galleries legitimately has no gallery shelf, so the row
  // simply does not exist.
  //
  // A *failed* row used to take that same path, which made a timeout on one
  // of the five requests look exactly like an empty shelf: the heading, the
  // cards and the See-all tile all disappeared and the remaining shelves
  // slid up with nothing saying why. One line under the heading is the whole
  // report — inert, because there is nothing to focus and the user's next
  // move is to go back to a tab, which asks again.
  if (!items.length) {
    if (!error) return null;
    return (
      <section className={styles.row} data-showroom-row={row.key}>
        <h2 className={styles.rowTitle}>{row.heading}</h2>
        <p className={styles.rowError}>Couldn't load {row.heading}</p>
      </section>
    );
  }

  // What a card hands back on select/long-press. `fetchPage: null` is the
  // app's established "this listing has nowhere to extend into" marker (see
  // `single()` in App.jsx) — a long-press "play all" from a shelf queues the
  // five scenes the user can actually see.
  const list = { items, total: items.length, page: 1, fetchPage: null };

  // Up out of the top shelf leaves Home for the rail, and the rail row that
  // belongs to Home is the active one — the same rule Left already follows.
  // Without the edge the geometry picks the *nearest* row above the card,
  // which is Scenes: a row the user is not on, one Down press from the wrong
  // part of the rail. Measured at 1920x1080 in showroom-entry's H11.
  const topEdge = isTop ? { up: 'nav-home' } : null;

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
              // Only one card on Home may claim focus on mount; otherwise all
              // four shelves race for it.
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
              // EntityCard calls `(item, index, items)`; these one-argument
              // wrappers are the app's existing handlers, unchanged.
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
