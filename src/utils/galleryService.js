/**
 * galleryService.js — Fetch galleries from the Stash GraphQL endpoint.
 *
 * The loader is `entityService.js`; what is specific to galleries is here.
 *
 * A Gallery is a *container* of images — a folder — where an Image is one file.
 * The distinction shows up in the schema rather than only in the prose: Gallery
 * has `folder`, `image_count` and a nested `cover: Image`, and Image has none
 * of those. `paths.cover` is what the card draws; the nested `cover` object
 * exists but would pull a whole Image per row for a field the paths object
 * already answers.
 *
 * Note the sort spelling: galleries take `images_count` (plural) but
 * `performer_count` and `tag_count` (singular). Stash is not consistent about
 * this across entities, so each menu was probed against its own resolver.
 */

import { withApiKey } from './stashUrl.js';
import { createEntityService } from './entityService.js';
import { coverArt, makeRng } from './mockArt.js';
import { GALLERY_TITLES } from './mockLibrary.js';

const MOCK_EPOCH = Date.UTC(2024, 0, 1);

function generateMockGalleries() {
  return GALLERY_TITLES.map((title, i) => {
    const rng = makeRng(`gallery-${i}`);
    const year = 2019 + (i % 6);
    const month = (i % 12) + 1;
    const day = (i % 28) + 1;
    return {
      id: `gallery-${i + 1}`,
      title,
      image_path: coverArt(`gallery-${i}`),
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      rating: rng() > 0.5 ? (rng() * 4 + 6).toFixed(1) : null,
      image_count: 1 + Math.floor(rng() * 120),
      performer_count: Math.floor(rng() * 12),
      tag_count: Math.floor(rng() * 20),
      file_count: 1 + Math.floor(rng() * 120),
      created_at: MOCK_EPOCH - i * 86400000,
      updated_at: MOCK_EPOCH - i * 3600000,
    };
  });
}

const FIND_GALLERIES_QUERY = `
  query FindGalleries($filter: FindFilterType, $gallery_filter: GalleryFilterType) {
    findGalleries(filter: $filter, gallery_filter: $gallery_filter) {
      count
      galleries {
        id
        title
        date
        rating100
        image_count
        paths {
          cover
        }
      }
    }
  }
`;

function normalizeGallery(g) {
  return {
    id: g.id,
    title: g.title,
    // `paths.cover` is absolute and unkeyed like every other media URL here.
    image_path: withApiKey(g?.paths?.cover) || null,
    date: g.date || null,
    rating: g.rating100 != null ? (g.rating100 / 10).toFixed(1) : null,
    image_count: g.image_count || 0,
  };
}

const service = createEntityService({
  kind: 'galleries',
  root: 'findGalleries',
  itemsKey: 'galleries',
  filterArg: 'gallery_filter',
  filterType: 'GalleryFilterType',
  query: FIND_GALLERIES_QUERY,
  normalize: normalizeGallery,
  mock: generateMockGalleries,
  searchFields: ['title'],
  mockSortKey: { images_count: 'image_count' },
});

/** Cached page fetch — see the note on fetchVideos in videoService.js. */
export async function fetchGalleries(opts = {}) {
  return service.fetch(opts);
}
