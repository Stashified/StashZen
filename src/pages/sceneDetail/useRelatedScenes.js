import { useEffect, useMemo, useState } from 'react';
import { fetchVideos } from '../../utils/videoService.js';

// One extra: the open scene is excluded client-side, and a row of three reads
// as a row that ran out.
const FETCH_LIMIT = 5;
const MAX_SHOWN = 4;

/**
 * "More from ..." rows for the open scene: its studio, then its first
 * performer. A row that comes back empty (or holding only this scene) is
 * dropped, so a library with no tagging shows no headers.
 *
 * Rows are fetched from the existing scene listing, not a new query: the
 * criterion is the same one the Studios and Performers pages use, and the
 * page cache means reopening the same scene costs nothing.
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

  const sources = useMemo(() => {
    const list = [];
    if (studioId != null) {
      list.push({
        key: 'studio',
        label: `More from ${studioName}`,
        filter: { studios: { modifier: 'INCLUDES', value: [String(studioId)] } },
      });
    }
    if (performerId != null) {
      list.push({
        key: 'performer',
        label: `More from ${performerName}`,
        filter: { performers: { modifier: 'INCLUDES', value: [String(performerId)] } },
      });
    }
    return list;
  }, [studioId, studioName, performerId, performerName]);

  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!enabled || !sources.length || sceneId == null) {
      setRows([]);
      return undefined;
    }

    let cancelled = false;
    setRows([]);

    // One failing row must not empty the other, hence allSettled.
    Promise.allSettled(sources.map(async (source) => {
      const { videos } = await fetchVideos({
        filter: source.filter,
        limit: FETCH_LIMIT,
        sort: 'created_at',
        order: 'desc',
      });
      return {
        ...source,
        items: videos
          .filter(v => String(v.id) !== String(sceneId))
          .slice(0, MAX_SHOWN),
      };
    })).then(results => {
      if (cancelled) return;
      setRows(results
        .map(r => (r.status === 'fulfilled' ? r.value : null))
        .filter(r => r && r.items.length));
    });

    return () => { cancelled = true; };
  }, [enabled, sources, sceneId]);

  return rows;
}
