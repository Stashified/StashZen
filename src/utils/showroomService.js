/**
 * showroomService.js: the five Home shelves in one request.
 *
 * They used to be five round trips fired together on every launch, all to the
 * same server at the same instant. One aliased document does the same work in
 * one connection and one parse.
 *
 * The field lists mirror the per-tab queries, because the rows are the same
 * cards: a field one of those normalizers starts reading has to be added here
 * too, or a shelf card silently loses it. Nothing here sorts randomly, so the
 * `stableSort` seeding in the services is not needed.
 *
 * Test mode keeps the five services' own mock paths: the generators are where
 * Test mode's furniture lives, and one shared decode of them is not worth
 * threading through this module.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';
import { translateFilter } from './filterTranslate.js';
import { fetchVideos, normalizeScene } from './videoService.js';
import { fetchStudios, normalizeStudio } from './studioService.js';
import { fetchPerformers, normalizePerformer } from './performerService.js';
import { fetchGalleries, normalizeGallery } from './galleryService.js';

// Five cards plus the See-all tile make six equal columns, see ShowroomRow.
const ROW_SIZE = 5;

// The document's aliased roots, in the order a partial answer is checked for
// anything at all.
const ALIASES = ['recentScenes', 'continueScenes', 'studios', 'performers', 'galleries'];

// "In progress" in the one shape both the shelf and its See-all hand-off send.
// A `resume_time` of 0 means never played or finished and reset, not resumable.
export const CONTINUE_FILTER = { resume_time: { modifier: 'GREATER_THAN', value: 0 } };

const SHOWROOM_QUERY = `
  query Showroom(
    $recentScenes: FindFilterType
    $continueScenes: FindFilterType
    $continueFilter: SceneFilterType
    $studios: FindFilterType
    $performers: FindFilterType
    $galleries: FindFilterType
  ) {
    recentScenes: findScenes(filter: $recentScenes) {
      scenes {
        id
        title
        date
        rating100
        play_count
        files { duration width height video_codec audio_codec format }
        resume_time
        paths { screenshot stream sprite vtt preview }
        studio { id name }
        tags { id name }
      }
    }
    continueScenes: findScenes(filter: $continueScenes, scene_filter: $continueFilter) {
      scenes {
        id
        title
        date
        rating100
        play_count
        files { duration width height video_codec audio_codec format }
        resume_time
        paths { screenshot stream sprite vtt preview }
        studio { id name }
        tags { id name }
      }
    }
    studios: findStudios(filter: $studios) {
      studios {
        id
        name
        image_path
        favorite
        rating100
        scene_count
        image_count
        gallery_count
        performer_count
        group_count
        parent_studio { id name }
        aliases
      }
    }
    performers: findPerformers(filter: $performers) {
      performers {
        id
        name
        disambiguation
        gender
        favorite
        image_path
        scene_count
        rating100
        country
        birthdate
        height_cm
      }
    }
    galleries: findGalleries(filter: $galleries) {
      galleries {
        id
        title
        date
        rating100
        image_count
        studio { id name }
        photographer
        folder { basename }
        paths { cover }
      }
    }
  }
`;

const pageFilter = (sort, order) => ({
  page: 1,
  per_page: ROW_SIZE,
  sort,
  direction: order === 'asc' ? 'ASC' : 'DESC',
});

const slice = (rows) => (rows || []).slice(0, ROW_SIZE);

/**
 * One object per shelf key in SHOWROOM_ROWS, each `{ items }`.
 *
 * `signal` cancels the request when Home unmounts: a superseded request would
 * otherwise hold a socket for the 12 s timeout while the tab the user moved to
 * waits behind it.
 */
export async function fetchShowroom({ signal } = {}) {
  if (getSettings().useMock) {
    const [recentScenes, continueScenes, studios, performers, galleries] = await Promise.all([
      fetchVideos({ sort: 'created_at', order: 'desc', page: 1, limit: ROW_SIZE, signal }),
      fetchVideos({
        sort: 'last_played_at', order: 'desc', filter: CONTINUE_FILTER,
        page: 1, limit: ROW_SIZE, signal,
      }),
      fetchStudios({ sort: 'created_at', order: 'desc', page: 1, limit: ROW_SIZE, signal }),
      fetchPerformers({ sort: 'created_at', order: 'desc', page: 1, limit: ROW_SIZE, signal }),
      fetchGalleries({ sort: 'date', order: 'desc', page: 1, limit: ROW_SIZE, signal }),
    ]);
    return {
      'recent-scenes': { items: slice(recentScenes.videos) },
      'continue-watching': { items: slice(continueScenes.videos) },
      'recent-studios': { items: slice(studios.studios) },
      'recent-performers': { items: slice(performers.performers) },
      'recent-galleries': { items: slice(galleries.galleries) },
    };
  }

  // One document, but GraphQL can fail one aliased root and answer the rest
  // (the error carries the partial data, see graphqlRequest). Keep every
  // healthy shelf and report only the one that failed, rather than blanking
  // all of Home over a single bad root.
  let data;
  let failure = null;
  try {
    data = await runQuery(SHOWROOM_QUERY, {
      recentScenes: pageFilter('created_at', 'desc'),
      continueScenes: pageFilter('last_played_at', 'desc'),
      continueFilter: translateFilter(CONTINUE_FILTER, 'SceneFilterType'),
      studios: pageFilter('created_at', 'desc'),
      performers: pageFilter('created_at', 'desc'),
      galleries: pageFilter('date', 'desc'),
    }, { signal });
  } catch (e) {
    const partial = e?.data;
    if (!partial || !ALIASES.some(alias => partial[alias] != null)) throw e;
    data = partial;
    failure = e.message || 'failed';
  }

  const scenes = (rows) => slice((rows || []).map(normalizeScene));
  // A null root in a partial answer is the shelf that failed; ShowroomRow
  // draws `error` as one inert line under its heading.
  const row = (alias, build) => (data?.[alias] != null
    ? { items: build(data[alias]) }
    : { items: [], error: failure || 'failed' });
  return {
    'recent-scenes': row('recentScenes', d => scenes(d.scenes)),
    'continue-watching': row('continueScenes', d => scenes(d.scenes)),
    'recent-studios': row('studios', d => slice((d.studios || []).map(normalizeStudio))),
    'recent-performers': row('performers', d => slice((d.performers || []).map(normalizePerformer))),
    'recent-galleries': row('galleries', d => slice((d.galleries || []).map(normalizeGallery))),
  };
}
