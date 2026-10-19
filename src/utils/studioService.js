/**
 * studioService.js — Fetch studios from the Stash GraphQL endpoint.
 *
 * The loader is `entityService.js`; what is specific to studios is here.
 *
 * Studio is the richest of the four: it has `rating100`, `organized` and
 * `o_counter`, and it is the only one with a `parent_studio`. It also has the
 * fewest valid sorts of the four — `performers_count` and `groups_count` are
 * both rejected by the resolver even though comparable values work on Tags,
 * which is why these menus were probed rather than copied across sections.
 *
 * The mock list is the same six studios `generateMockVideos` already uses as
 * scene categories, rather than six new invented names. Test mode is more
 * legible when a studio you can browse is a studio the scenes belong to.
 */

import { withApiKey } from './stashUrl.js';
import { createEntityService } from './entityService.js';
import { coverArt, makeRng } from './mockArt.js';
import { STUDIOS } from './mockLibrary.js';

const MOCK_EPOCH = Date.UTC(2024, 0, 1);

function generateMockStudios() {
  return STUDIOS.map((name, i) => {
    const rng = makeRng(`studio-${i}`);
    // The two sorts the Related group offers that the row did not carry. From
    // a separate stream so no existing fixture value moves.
    const extra = makeRng(`studio-sort-${i}`);
    return {
      id: `studio-${i + 1}`,
      name,
      // Landscape: a studio image is a logo or a building, not a portrait.
      image_path: coverArt(`studio-${i}`),
      favorite: rng() > 0.8,
      rating: rng() > 0.45 ? (rng() * 3 + 6.5).toFixed(1) : null,
      scene_count: 1 + Math.floor(rng() * 90),
      image_count: Math.floor(rng() * 400),
      gallery_count: Math.floor(rng() * 50),
      performer_count: Math.floor(rng() * 25),
      group_count: Math.floor(rng() * 4),
      tag_count: Math.floor(extra() * 40),
      child_count: Math.floor(extra() * 5),
      created_at: MOCK_EPOCH - i * 86400000,
      updated_at: MOCK_EPOCH - i * 3600000,
    };
  });
}

const FIND_STUDIOS_QUERY = `
  query FindStudios($filter: FindFilterType, $studio_filter: StudioFilterType) {
    findStudios(filter: $filter, studio_filter: $studio_filter) {
      count
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
      }
    }
  }
`;

function normalizeStudio(s) {
  return {
    id: s.id,
    name: s.name,
    image_path: withApiKey(s.image_path) || null,
    favorite: !!s.favorite,
    // Scaled to 0–10 the way the performer card does it, so one control means
    // one thing across sections. The server side is 0–100.
    rating: s.rating100 != null ? (s.rating100 / 10).toFixed(1) : null,
    scene_count: s.scene_count || 0,
    image_count: s.image_count || 0,
    gallery_count: s.gallery_count || 0,
    performer_count: s.performer_count || 0,
    group_count: s.group_count || 0,
  };
}

const service = createEntityService({
  kind: 'studios',
  root: 'findStudios',
  itemsKey: 'studios',
  filterArg: 'studio_filter',
  filterType: 'StudioFilterType',
  query: FIND_STUDIOS_QUERY,
  normalize: normalizeStudio,
  mock: generateMockStudios,
  searchFields: ['name'],
  mockSortKey: {
    scenes_count: 'scene_count',
    images_count: 'image_count',
    galleries_count: 'gallery_count',
  },
});

/** Cached page fetch — see the note on fetchVideos in videoService.js. */
export async function fetchStudios(opts = {}) {
  return service.fetch(opts);
}
