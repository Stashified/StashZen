/**
 * studioService.js: Fetch studios from the Stash GraphQL endpoint.
 *
 * The loader is `entityService.js`; what is specific to studios is here.
 *
 * Studio is the richest of the four: `rating100`, `organized`, `o_counter`, and
 * the only `parent_studio`. It also has the fewest valid sorts, the resolver
 * rejects `performers_count` and `groups_count` though comparable values work
 * on Tags, which is why these menus were probed rather than copied.
 *
 * The mock list is the same six studios `generateMockVideos` uses as scene
 * categories, so a studio you can browse is one the scenes belong to.
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
    // A third stream for the hero enrichment fields, for the same reason.
    const hero = makeRng(`studio-extra2-${i}`);
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
      parentStudio: hero() > 0.75 && i > 0
        ? { id: `studio-${i}`, name: STUDIOS[(i - 1) % STUDIOS.length] }
        : null,
      aliases: hero() > 0.55 ? [`${name} Alt`] : [],
      details: hero() > 0.5
        ? `${name} is a sample studio description used to exercise the hero's clamped blurb.`
        : null,
      created_at: MOCK_EPOCH - i * 86400000,
      updated_at: MOCK_EPOCH - i * 3600000,
    };
  });
}

// `details` is deliberately absent: it is a paragraph per studio and the only
// consumer is the Carousel hero's blurb. `parent_studio` and `aliases` stay
// because list rows render the hero meta model, which includes both.
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
        parent_studio {
          id
          name
        }
        aliases
      }
    }
  }
`;

// Same rows, with the hero's free-text field.
const FIND_STUDIOS_HERO_QUERY = `
  query FindStudiosHero($filter: FindFilterType, $studio_filter: StudioFilterType) {
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
        parent_studio {
          id
          name
        }
        aliases
        details
      }
    }
  }
`;

export function normalizeStudio(s) {
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
    parentStudio: s.parent_studio
      ? { id: s.parent_studio.id, name: s.parent_studio.name }
      : null,
    aliases: (s.aliases || []).filter(Boolean),
    details: s.details || null,
  };
}

const service = createEntityService({
  kind: 'studios',
  root: 'findStudios',
  itemsKey: 'studios',
  filterArg: 'studio_filter',
  filterType: 'StudioFilterType',
  query: FIND_STUDIOS_QUERY,
  heroQuery: FIND_STUDIOS_HERO_QUERY,
  normalize: normalizeStudio,
  mock: generateMockStudios,
  searchFields: ['name'],
  mockSortKey: {
    scenes_count: 'scene_count',
    images_count: 'image_count',
    galleries_count: 'gallery_count',
  },
});

/** Cached page fetch, see the note on fetchVideos in videoService.js. */
export async function fetchStudios(opts = {}) {
  return service.fetch(opts);
}
