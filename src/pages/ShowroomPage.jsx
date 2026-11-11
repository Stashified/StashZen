/**
 * Home as five curated shelves: four Recently Added plus Continue Watching
 * below Recently Added Scenes.
 *
 * Five cards plus a See-all tile make a ~258px card and put three shelves fully
 * in view at 1080p, with the fourth peeking; six cards gave 218px and only two
 * and a bit. See all is the deliberate way past a sideways row's unseen edge.
 * All five rows arrive in one aliased request (showroomService), each its page
 * 1 only, so `usePagedList`'s paging rules do not apply.
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
import { fetchShowroom, CONTINUE_FILTER } from '../utils/showroomService.js';
import { onRowPatch } from '../utils/rowPatches.js';
import styles from './ShowroomPage.module.css';


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
  },
];

export default function ShowroomPage({
  onVideoSelect, onVideoLongPress, onStudioSelect,
  onPerformerSelect, onGallerySelect, onSeeAll,
  clearedSceneIds,
}) {
  // `null` while the request is in flight, then one entry per row key.
  const [rows, setRows] = useState(null);

  // Empty deps deliberately: page 1 of fixed queries. `<main key={dataKey}>`
  // remounts the page on source change; aborting drops a request whose tab has
  // already been left, instead of holding its socket until the timeout.
  useEffect(() => {
    const controller = new AbortController();
    fetchShowroom({ signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setRows(next);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        // `fetchShowroom` already returned the healthy shelves when only one
        // root failed, so reaching here means none answered: every shelf says
        // so under its heading rather than one silently vanishing.
        const error = e?.message || 'failed';
        setRows(Object.fromEntries(
          SHOWROOM_ROWS.map(row => [row.key, { items: [], error }]),
        ));
      });
    return () => controller.abort();
  }, []);

  // A write publishes the fields it changed; patch the shelf card in place,
  // since these fetches only re-run on remount.
  useEffect(() => onRowPatch('scene', (id, patch) => {
    setRows((prev) => {
      if (!prev) return prev;
      let changed = false;
      const next = {};
      for (const [key, row] of Object.entries(prev)) {
        // Ids are per entity kind, so a scene's 5 is not a performer's 5.
        // The kind lives on the row descriptor, not on the fetched data.
        const kind = SHOWROOM_ROWS.find(r => r.key === key)?.kind;
        if (kind !== 'scene' || !row.items.some(it => String(it.id) === id)) {
          next[key] = row;
          continue;
        }
        changed = true;
        next[key] = {
          ...row,
          items: row.items.map(it => (String(it.id) === id ? { ...it, ...patch } : it)),
        };
      }
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

  // `clearedSceneIds` is the page's one live patch: clearing a resume point
  // cannot refetch the shelf underneath (still mounted, requests re-run only on
  // remount), so the cleared card is filtered out here. Only Continue Watching
  // is affected; App empties the set on tab change so the next visit asks again.
  const itemsFor = (row) => {
    const items = rows[row.key]?.items || [];
    if (row.key !== 'continue-watching' || !clearedSceneIds?.size) return items;
    return items.filter(item => !clearedSceneIds.has(String(item.id)));
  };
  const itemsByKey = new Map(SHOWROOM_ROWS.map(row => [row.key, itemsFor(row)]));
  const anyItems = [...itemsByKey.values()].some(items => items.length);

  if (!anyItems) {
    return (
      <div className={styles.page}>
        <p className={styles.stateText}>
          {SHOWROOM_ROWS.some(r => rows[r.key]?.error) ? 'Could not load Home.' : 'Nothing to show yet.'}
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
          error={rows[row.key]?.error || null}
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
