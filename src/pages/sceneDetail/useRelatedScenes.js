import { useEffect, useMemo, useState } from 'react';
import { fetchRelatedScenes } from '../../utils/videoService.js';

// One extra: the open scene is excluded client-side, and a row of three reads
// as a row that ran out.
const FETCH_LIMIT = 5;
const MAX_SHOWN = 4;

/**
 * "More from ..." rows for the open scene: its studio, then its first
 * performer. A row that comes back empty (or holding only this scene) is
 * dropped, so a library with no tagging shows no headers.
 *
 * Both rows are one aliased listing request (`fetchRelatedScenes`): they are
 * the same criterion the Studios and Performers pages use, fired at the same
 * instant, and the module cache means reopening the same scene still costs
 * nothing.
 *
 * `detail` starts as the card and is replaced by the full answer, so the ids
 * are what the effect keys on: a rating change replaces `detail` and must not
 * refetch.
 */
export function useRelatedScenes(detail, enabled = true) {
  const sceneId = detail?.id;
  const studioId = detail?.studio?.id;
  const studioName = detail?.studio?.name;
  const performerId = detail?.performers?.[0]?.id;
  const performerName = detail?.performers?.[0]?.name;

  const studioFilter = useMemo(
    () => (studioId == null
      ? null
      : { studios: { modifier: 'INCLUDES', value: [String(studioId)] } }),
    [studioId],
  );
  const performerFilter = useMemo(
    () => (performerId == null
      ? null
      : { performers: { modifier: 'INCLUDES', value: [String(performerId)] } }),
    [performerId],
  );

  const labels = useMemo(() => ({
    // The row `key` stays studio/performer: it is the focus-id prefix
    // (`related-studio-7`) the grid and the harness read, not the request's
    // alias.
    studio: studioName ? `More from ${studioName}` : null,
    performer: performerName ? `More from ${performerName}` : null,
  }), [studioName, performerName]);

  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!enabled || sceneId == null || (!studioFilter && !performerFilter)) {
      setRows([]);
      return undefined;
    }

    let cancelled = false;
    setRows([]);
    const controller = new AbortController();

    fetchRelatedScenes({
      studioFilter, performerFilter, limit: FETCH_LIMIT, signal: controller.signal,
    }).then((data) => {
      if (cancelled) return;
      const rowsOut = [];
      for (const [key, alias, filter] of [
        ['studio', 'byStudio', studioFilter],
        ['performer', 'byPerformer', performerFilter],
      ]) {
        if (!filter) continue;
        const items = (data[alias] || [])
          .filter(v => String(v.id) !== String(sceneId))
          .slice(0, MAX_SHOWN);
        if (items.length) rowsOut.push({ key, label: labels[key], filter, items });
      }
      setRows(rowsOut);
    }).catch(() => {
      // Only a document with no healthy root rejects; a partial answer already
      // arrives carrying the row that survived. Nothing usable, no rows.
      if (!cancelled) setRows([]);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, studioFilter, performerFilter, sceneId, labels]);

  return rows;
}
