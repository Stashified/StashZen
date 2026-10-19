/**
 * ShowroomPage — Home as five curated shelves.
 *
 * This is what Home became in 0.15.0: the full scene listing (grid, carousel,
 * coverflow, filters, search) lives on the Scenes tab, and Home is a fixed set
 * of shelves. As of 0.18.0 it mirrors Stash's home — Recently Added Scenes,
 * Recently Added Studios, Recently Added Performers, Recently Released
 * Galleries — and the Best Rated/Favorite shelf is gone. As of 0.18.4 a fifth
 * shelf, Continue Watching, sits directly below Recently Added Scenes: the
 * library's own lead shelf stays first, and the user's in-progress queue is
 * the second thing on screen. Each shelf is five cards wide with a See-all
 * tile as the sixth item; the first shelf owns the single autofocus and the
 * Up-to-the-rail edge.
 *
 * **Why five and not six.** Six cards at 1080p made a 218px card and only two
 * and a bit shelves on screen. Five makes a ~258px card and puts the first
 * three shelves fully in view, with the fourth peeking above the fold — the
 * "bigger cards, three rows at once" the TV asked for. The grid has exactly
 * six tracks because the tile is the sixth item.
 *
 * **Why See all exists rather than horizontal scrolling.** A row that scrolls
 * sideways has an edge the user cannot see: Right on the last visible card
 * either does nothing or moves focus to something off-screen, and there is no
 * way to tell which until the press lands. With a fixed top five, the strip is
 * exactly what is on screen, and the one deliberate way out of it is a tile
 * that says so.
 *
 * **Why each row owns its fetch.** The five rows are five different queries,
 * page 1 only. `usePagedList` is the app's infinite-list machine —
 * reset, append, dedupe, exhaustion — none of which applies to a shelf that
 * never pages. `Promise.all` plus a slice is the whole contract.
 *
 * **The sort values are a contract with the tab they open.** Stash's `SortBy`
 * is shared, so `date` (release date) and `created_at` (date added) are both
 * valid for scenes and galleries, and mean different things; studios and
 * performers take `created_at`. Three of the five hand-offs keep a sort that
 * is *not* their tab's default (`date` for Galleries, `created_at` for
 * Studios, `last_played_at` for Continue Watching), which is why App.jsx's
 * See-all path carries `sortForTab` rather than letting the arrival rule
 * overwrite it. Scenes and Performers ask for their tab's own default.
 * Every value here must also exist in the destination's `sortGroups`, or the
 * Sort control would render a raw string.
 *
 * The row definitions are exported because the See-all hand-off in App.jsx
 * needs the same sort/order/filter the row asked for; keeping them in one
 * table is what stops the row and its destination from drifting apart.
 */

import { useEffect, useState } from 'react';
import ShowroomRow from '../components/ShowroomRow.jsx';
import { STUDIO_VIEW, GALLERY_VIEW } from '../components/entityViews.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { fetchStudios } from '../utils/studioService.js';
import { fetchPerformers } from '../utils/performerService.js';
import { fetchGalleries } from '../utils/galleryService.js';
import styles from './ShowroomPage.module.css';

// Five cards plus the See-all tile make six equal columns.
export const ROW_SIZE = 5;

// "In progress", in the one shape both the shelf and its See-all hand-off
// send. A scene with `resume_time` 0 has either never been played or was
// finished and reset; either way it is not something to continue.
const CONTINUE_FILTER = { resume_time: { modifier: 'GREATER_THAN', value: 0 } };

/**
 * The showroom's one source of truth.
 *
 * `filter` is GraphQL-shaped, like every criterion App builds for a request
 * (`translateFilter` passes it through unchanged). Only Continue Watching is
 * filtered: `resume_time > 0` is what makes a scene "in progress", and the
 * same criterion travels to Scenes when its See-all tile is pressed. `kind`
 * selects the card family, and `view` is the descriptor the entity cards need.
 */
export const SHOWROOM_ROWS = [
  {
    key: 'recent-scenes',
    // Titled for what it actually sorts on (`created_at`). It was "Recently
    // Released" while it sorted by release date, and kept the name after the
    // sort changed — so the heading described a different shelf than the one
    // below it. The key and focus ids stay `recent-scenes`: they are wired
    // into App.jsx and the harness and are not user-visible.
    heading: 'Recently Added Scenes',
    kind: 'scene',
    focusIdPrefix: 'showroom-recent-scenes-video',
    seeAllFocusId: 'showroom-seeall-recent-scenes',
    // Newest *added* scenes, not newest release date. `date` sorts on the
    // scene's release date, which leaves a freshly added old film buried;
    // `created_at` is the order the library actually grew in, and it is also
    // the Scenes tab's own default, so the See-all hand-off needs no change
    // of vocabulary. Reported from the TV: "showroom recently released
    // scenes i would like to show newest scenes by date created".
    sort: 'created_at',
    order: 'desc',
    filter: null,
    toTab: 'scenes',
    fetchPage: async () => {
      const d = await fetchVideos({
        sort: 'created_at', order: 'desc', page: 1, limit: ROW_SIZE,
      });
      return { items: d.videos, total: d.total };
    },
  },
  {
    key: 'continue-watching',
    heading: 'Continue Watching',
    kind: 'scene',
    focusIdPrefix: 'showroom-continue-video',
    seeAllFocusId: 'showroom-seeall-continue',
    // Newest play first, not newest scene: the shelf is a queue of where the
    // user stopped, so the thing they were watching most recently is the one
    // furthest left. `last_played_at` and `resume_time` are both in Scenes'
    // sort vocabulary / filter schema, which the See-all hand-off relies on.
    sort: 'last_played_at',
    order: 'desc',
    filter: CONTINUE_FILTER,
    toTab: 'scenes',
    fetchPage: async () => {
      const d = await fetchVideos({
        sort: 'last_played_at', order: 'desc', filter: CONTINUE_FILTER,
        page: 1, limit: ROW_SIZE,
      });
      return { items: d.videos, total: d.total };
    },
  },
  {
    key: 'recent-studios',
    heading: 'Recently Added Studios',
    kind: 'studio',
    view: STUDIO_VIEW,
    seeAllFocusId: 'showroom-seeall-recent-studios',
    sort: 'created_at',
    order: 'desc',
    filter: null,
    toTab: 'studios',
    fetchPage: async () => {
      const d = await fetchStudios({
        sort: 'created_at', order: 'desc', page: 1, limit: ROW_SIZE,
      });
      return { items: d.studios, total: d.total };
    },
  },
  {
    key: 'recent-performers',
    heading: 'Recently Added Performers',
    kind: 'performer',
    seeAllFocusId: 'showroom-seeall-recent-performers',
    sort: 'created_at',
    order: 'desc',
    filter: null,
    toTab: 'performers',
    fetchPage: async () => {
      const d = await fetchPerformers({
        sort: 'created_at', order: 'desc', page: 1, limit: ROW_SIZE,
      });
      return { items: d.performers, total: d.total };
    },
  },
  {
    key: 'recent-galleries',
    heading: 'Recently Released Galleries',
    kind: 'gallery',
    view: GALLERY_VIEW,
    seeAllFocusId: 'showroom-seeall-recent-galleries',
    sort: 'date',
    order: 'desc',
    filter: null,
    toTab: 'galleries',
    fetchPage: async () => {
      const d = await fetchGalleries({
        sort: 'date', order: 'desc', page: 1, limit: ROW_SIZE,
      });
      return { items: d.galleries, total: d.total };
    },
  },
];

export default function ShowroomPage({
  onVideoSelect, onVideoLongPress, onStudioSelect,
  onPerformerSelect, onGallerySelect, onSeeAll,
  clearedSceneIds,
}) {
  // `null` while the five requests are in flight; an array afterwards, one
  // entry per row in SHOWROOM_ROWS order.
  const [rows, setRows] = useState(null);

  // Empty deps deliberately: the five requests are page 1 of fixed queries.
  // `<main key={dataKey}>` remounts this whole page when the source changes,
  // and both services partition their caches by source, so there is nothing
  // here that could go stale behind a dependency. The cancel flag is the same
  // guard the list hooks use: a remount must not write an old result.
  useEffect(() => {
    let cancelled = false;
    Promise.all(SHOWROOM_ROWS.map(async (row) => {
      try {
        const { items } = await row.fetchPage();
        // Mock scene fetches ignore `limit` and return all 48, so the slice is
        // the row contract, not a redundancy on top of it.
        return { key: row.key, items: (items || []).slice(0, ROW_SIZE), error: null };
      } catch (e) {
        return { key: row.key, items: [], error: e?.message || 'failed' };
      }
    })).then((next) => {
      if (!cancelled) setRows(next);
    });
    return () => { cancelled = true; };
  }, []);

  if (rows === null) {
    return (
      <div className={styles.page}>
        <div className={styles.state}>
          <div className={styles.spinner} aria-label="Loading Home" />
          <p className={styles.stateText}>Loading…</p>
        </div>
      </div>
    );
  }

  const byKey = new Map(rows.map(r => [r.key, r]));

  // `clearedSceneIds` is the page's one live patch. Clearing a resume point
  // from the detail overlay cannot refetch the shelf underneath — it is still
  // mounted, and its five requests only re-run on a remount — so the card the
  // user just cleared is filtered out here instead. Only Continue Watching is
  // affected; the same scene may legitimately still be in a date-ordered
  // shelf. App empties the set on every tab change, so the next visit asks
  // the server again rather than trusting a patch made some screens ago.
  const itemsFor = (row) => {
    const items = byKey.get(row.key)?.items || [];
    if (row.key !== 'continue-watching' || !clearedSceneIds?.size) return items;
    return items.filter(item => !clearedSceneIds.has(String(item.id)));
  };
  const itemsByKey = new Map(SHOWROOM_ROWS.map(row => [row.key, itemsFor(row)]));
  const anyItems = [...itemsByKey.values()].some(items => items.length);

  if (!anyItems) {
    return (
      <div className={styles.page}>
        <p className={styles.stateText}>
          {rows.some(r => r.error) ? 'Could not load Home.' : 'Nothing to show yet.'}
        </p>
      </div>
    );
  }

  // The shelf that actually renders first owns the rail edge and the single
  // autofocus. Keyed off `recent-scenes` instead, an empty first shelf would
  // put both on a component that returns null and leave focus unclaimed.
  const firstVisibleKey = SHOWROOM_ROWS
    .find(r => itemsByKey.get(r.key).length)?.key;

  return (
    <div className={styles.page}>
      {/* Rendered from SHOWROOM_ROWS, not from `rows`, so the order is the
          table's order; an empty row renders nothing and the next one moves up. */}
      {SHOWROOM_ROWS.map(row => (
        <ShowroomRow
          key={row.key}
          row={row}
          items={itemsByKey.get(row.key)}
          error={byKey.get(row.key)?.error || null}
          isTop={row.key === firstVisibleKey}
          onVideoSelect={onVideoSelect}
          onVideoLongPress={onVideoLongPress}
          onStudioSelect={onStudioSelect}
          onPerformerSelect={onPerformerSelect}
          onGallerySelect={onGallerySelect}
          onSeeAll={onSeeAll}
        />
      ))}
    </div>
  );
}
