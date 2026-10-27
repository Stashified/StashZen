/**
 * Home as five curated shelves: four Recently Added plus Continue Watching
 * below Recently Added Scenes.
 *
 * Five cards plus a See-all tile make a ~258px card and put three shelves fully
 * in view at 1080p, with the fourth peeking; six cards gave 218px and only two
 * and a bit. See all is the deliberate way past a sideways row's unseen edge.
 * Each row is a page-1-only query, so `usePagedList`'s paging rules do not apply.
 *
 * The sort values are a contract with the tab they open: Stash's `SortBy` is
 * shared, so `date` (release) and `created_at` (added) differ. Three hand-offs
 * keep a non-default sort, which is why App's See-all carries `sortForTab`
 * instead of letting the arrival rule overwrite it; every value must exist in
 * the destination's `sortGroups` or Sort renders a raw string. The row
 * definitions are exported so a row and its destination cannot drift apart.
 */

import { useEffect, useState } from 'react';
import ShowroomRow from '../components/ShowroomRow.jsx';
import { STUDIO_VIEW, GALLERY_VIEW } from '../components/entityViews.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { fetchStudios } from '../utils/studioService.js';
import { fetchPerformers } from '../utils/performerService.js';
import { fetchGalleries } from '../utils/galleryService.js';
import { onRowPatch } from '../utils/rowPatches.js';
import styles from './ShowroomPage.module.css';

// Five cards plus the See-all tile make six equal columns.
export const ROW_SIZE = 5;

// "In progress" in the one shape both the shelf and its See-all hand-off send.
// A `resume_time` of 0 means never played or finished and reset, not resumable.
const CONTINUE_FILTER = { resume_time: { modifier: 'GREATER_THAN', value: 0 } };

/**
 * The showroom's one source of truth. `filter` is GraphQL-shaped like App's
 * criteria; only Continue Watching filters. `kind` selects the card family and
 * `view` is the descriptor the entity cards need.
 */
export const SHOWROOM_ROWS = [
  {
    key: 'recent-scenes',
    // Titled for what it sorts on (`created_at`). The key and focus ids stay
    // `recent-scenes`: they are wired into App and the harness, not user-visible.
    heading: 'Recently Added Scenes',
    kind: 'scene',
    focusIdPrefix: 'showroom-recent-scenes-video',
    seeAllFocusId: 'showroom-seeall-recent-scenes',
    // Newest *added*, not newest release: `date` buries a freshly added old
    // film. `created_at` is also the Scenes tab's default, so See-all needs no
    // change of vocabulary.
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
    // Newest play first, not newest scene: a queue of where the user stopped,
    // so the most recently watched is furthest left. Both `last_played_at` and
    // `resume_time` are in Scenes' vocabulary, which See-all relies on.
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
  // `null` while the five requests are in flight, then one entry per row.
  const [rows, setRows] = useState(null);

  // Empty deps deliberately: page 1 of fixed queries. `<main key={dataKey}>`
  // remounts the page on source change and both services partition their caches
  // by source; the cancel flag stops a remount writing an old result.
  useEffect(() => {
    let cancelled = false;
    Promise.all(SHOWROOM_ROWS.map(async (row) => {
      try {
        const { items } = await row.fetchPage();
        // Mock scene fetches ignore `limit`, so the slice is the row contract.
        return { key: row.key, items: (items || []).slice(0, ROW_SIZE), error: null };
      } catch (e) {
        return { key: row.key, items: [], error: e?.message || 'failed' };
      }
    })).then((next) => {
      if (!cancelled) setRows(next);
    });
    return () => { cancelled = true; };
  }, []);

  // A write publishes the fields it changed; patch the shelf card in place,
  // since these fetches only re-run on remount.
  useEffect(() => onRowPatch('scene', (id, patch) => {
    setRows((prev) => {
      if (!prev) return prev;
      let changed = false;
      const next = prev.map((row) => {
        if (!row.items.some(it => String(it.id) === id)) return row;
        changed = true;
        return {
          ...row,
          items: row.items.map(it => (String(it.id) === id ? { ...it, ...patch } : it)),
        };
      });
      return changed ? next : prev;
    });
  }), []);

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

  // `clearedSceneIds` is the page's one live patch: clearing a resume point
  // cannot refetch the shelf underneath (still mounted, requests re-run only on
  // remount), so the cleared card is filtered out here. Only Continue Watching
  // is affected; App empties the set on tab change so the next visit asks again.
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
  // autofocus; keying off `recent-scenes` would give both to a row returning null.
  const firstVisibleKey = SHOWROOM_ROWS
    .find(r => itemsByKey.get(r.key).length)?.key;

  return (
    <div className={styles.page}>
      {/* Rendered from SHOWROOM_ROWS so order is the table's; empty rows render
          nothing and the next one moves up. */}
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
