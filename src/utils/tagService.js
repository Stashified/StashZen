/**
 * tagService.js — Fetch tags from the Stash GraphQL endpoint.
 *
 * The loader is `entityService.js`; what is specific to tags is here.
 *
 * Only the fields confirmed to exist on `Tag` are selected — no `rating100`,
 * because Tag does not have one (Studio does, and the two cards therefore
 * cannot be the same card with a different name). Verified by introspection
 * against Stash 0.31.1, along with the sort values below.
 *
 * The sort *values* use Stash's plural `_count` spelling while the selected
 * fields are singular, which is why `MOCK_SORT_KEY` exists: without it a
 * Test-mode sort by any count silently does nothing. See the note on the
 * comparator in entityService.js.
 */

import { withApiKey } from './stashUrl.js';
import { createEntityService } from './entityService.js';
import { coverArt, makeRng } from './mockArt.js';
import { TAG_NAMES } from './mockLibrary.js';

// A fixed base rather than `Date.now()`, so mock order is the same on every
// launch. The three older generators use the wall clock, which is why their
// Test-mode ordering shifts between runs; nothing depends on that here.
const MOCK_EPOCH = Date.UTC(2024, 0, 1);

function generateMockTags() {
  return TAG_NAMES.map((name, i) => {
    const rng = makeRng(`tag-${i}`);
    // Separate stream: the values below are pinned by the harness.
    const extra = makeRng(`tag-extra-${i}`);
    return {
      id: `tag-${i + 1}`,
      name,
      // Portrait, matching how the card lays it out. A design choice rather
      // than a measurement: a real library's tag images are whatever the user
      // set, and this is the shape the grid is built for.
      image_path: coverArt(`tag-${i}`, { portrait: true }),
      favorite: rng() > 0.88,
      scene_count: 1 + Math.floor(rng() * 240),
      scene_marker_count: Math.floor(rng() * 90),
      image_count: Math.floor(rng() * 600),
      gallery_count: Math.floor(rng() * 40),
      performer_count: Math.floor(rng() * 30),
      studio_count: Math.floor(rng() * 6),
      // A real library's tags are mostly undescribed; roughly half here get
      // a description and aliases so both the populated and the empty hero
      // paths are reachable in Test mode.
      description: extra() > 0.5
        ? `${name} is a sample tag description used to exercise the hero's clamped blurb.`
        : null,
      aliases: extra() > 0.55 ? [`${name} alias`, `${name} alt`] : [],
      created_at: MOCK_EPOCH - i * 86400000,
      updated_at: MOCK_EPOCH - i * 3600000,
    };
  });
}

// `description` is deliberately absent: it is a paragraph per tag and the only
// consumer is the Carousel hero's blurb. The grid and list use this document;
// the Carousel asks for the hero variant below. `aliases` stays here because
// list rows render the hero meta model, which includes them.
const FIND_TAGS_QUERY = `
  query FindTags($filter: FindFilterType, $tag_filter: TagFilterType) {
    findTags(filter: $filter, tag_filter: $tag_filter) {
      count
      tags {
        id
        name
        image_path
        favorite
        scene_count
        scene_marker_count
        image_count
        gallery_count
        performer_count
        studio_count
        aliases
      }
    }
  }
`;

// Same rows, with the hero's free-text field. A distinct operation name so
// the two documents are distinguishable in a server log.
const FIND_TAGS_HERO_QUERY = `
  query FindTagsHero($filter: FindFilterType, $tag_filter: TagFilterType) {
    findTags(filter: $filter, tag_filter: $tag_filter) {
      count
      tags {
        id
        name
        image_path
        favorite
        scene_count
        scene_marker_count
        image_count
        gallery_count
        performer_count
        studio_count
        description
        aliases
      }
    }
  }
`;

export function normalizeTag(t) {
  return {
    id: t.id,
    name: t.name,
    // Every one of these arrives absolute and unkeyed and 302s to the login
    // page without the key — see stashUrl.js. `image_path` is a non-empty
    // string for every tag in this library, which does NOT mean a picture is
    // there: Stash serves a generated-asset URL whether or not Generate has
    // run, so the card's fallback is reached by onError, never by an absent
    // field.
    image_path: withApiKey(t.image_path) || null,
    favorite: !!t.favorite,
    scene_count: t.scene_count || 0,
    scene_marker_count: t.scene_marker_count || 0,
    image_count: t.image_count || 0,
    gallery_count: t.gallery_count || 0,
    performer_count: t.performer_count || 0,
    studio_count: t.studio_count || 0,
    description: t.description || null,
    aliases: (t.aliases || []).filter(Boolean),
  };
}

const service = createEntityService({
  kind: 'tags',
  root: 'findTags',
  itemsKey: 'tags',
  filterArg: 'tag_filter',
  filterType: 'TagFilterType',
  query: FIND_TAGS_QUERY,
  heroQuery: FIND_TAGS_HERO_QUERY,
  normalize: normalizeTag,
  mock: generateMockTags,
  searchFields: ['name'],
  mockSortKey: {
    scenes_count: 'scene_count',
    scene_markers_count: 'scene_marker_count',
    images_count: 'image_count',
    galleries_count: 'gallery_count',
    performers_count: 'performer_count',
    studios_count: 'studio_count',
  },
});

/** Cached page fetch — see the note on fetchVideos in videoService.js. */
export async function fetchTags(opts = {}) {
  return service.fetch(opts);
}
