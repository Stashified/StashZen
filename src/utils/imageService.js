/**
 * imageService.js — Fetch images from the Stash GraphQL endpoint.
 *
 * The loader is `entityService.js`; what is specific to images is here.
 *
 * An Image is one file. It has no `folder` (a Gallery has one) — this library
 * holds 31,251 of them, which is why the grid is 40 a page and appends only
 * when the user scrolls to it, and why nothing here preloads.
 *
 * Three URLs come back per row and they are three different sizes of the same
 * picture:
 *   - `paths.thumbnail` — what the grid tile draws
 *   - `paths.preview`   — a mid-size still
 *   - `paths.image`     — the full-resolution file, for the viewer
 * All three are absolute and unkeyed and need `withApiKey()`. The tile and the
 * viewer deliberately do not share a field: pulling full-resolution art for
 * every tile on screen is the one thing that would make this section slow.
 *
 * Test mode draws both sizes from the same seed, so the picture in the viewer
 * is the picture on the tile. `coverArt` is SVG, so it scales rather than
 * blurring — there is no second, larger drawing to make.
 */

import { withApiKey } from './stashUrl.js';
import { createEntityService } from './entityService.js';
import { coverArt, makeRng } from './mockArt.js';

const MOCK_EPOCH = Date.UTC(2024, 0, 1);
const MOCK_IMAGE_COUNT = 120;

function generateMockImages() {
  return Array.from({ length: MOCK_IMAGE_COUNT }, (_, i) => {
    const rng = makeRng(`image-${i}`);
    const art = coverArt(`image-${i}`);
    const year = 2019 + (i % 6);
    const month = (i % 12) + 1;
    const day = (i % 28) + 1;
    return {
      id: `img-${i + 1}`,
      // Filename-shaped, because that is what an image's title usually is:
      // Stash defaults it to the file on disk.
      title: `DSC_${String(i + 1).padStart(4, '0')}.JPG`,
      image_path: art,
      full: art,
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      rating: rng() > 0.6 ? (rng() * 4 + 6).toFixed(1) : null,
      o_counter: Math.floor(rng() * 30),
      performer_count: Math.floor(rng() * 6),
      tag_count: Math.floor(rng() * 15),
      file_count: 1,
      filesize: 800000 + Math.floor(rng() * 9000000),
      resolution: i % 5 === 0 ? '3840x2160' : '1920x1080',
      created_at: MOCK_EPOCH - i * 3600000,
      updated_at: MOCK_EPOCH - i * 600000,
    };
  });
}

const FIND_IMAGES_QUERY = `
  query FindImages($filter: FindFilterType, $image_filter: ImageFilterType) {
    findImages(filter: $filter, image_filter: $image_filter) {
      count
      images {
        id
        title
        date
        rating100
        o_counter
        paths {
          thumbnail
          image
        }
      }
    }
  }
`;

function normalizeImage(im) {
  return {
    id: im.id,
    title: im.title,
    image_path: withApiKey(im?.paths?.thumbnail) || null,
    full: withApiKey(im?.paths?.image) || null,
    date: im.date || null,
    rating: im.rating100 != null ? (im.rating100 / 10).toFixed(1) : null,
    o_counter: im.o_counter || 0,
  };
}

const service = createEntityService({
  kind: 'images',
  root: 'findImages',
  itemsKey: 'images',
  filterArg: 'image_filter',
  filterType: 'ImageFilterType',
  query: FIND_IMAGES_QUERY,
  normalize: normalizeImage,
  mock: generateMockImages,
  searchFields: ['title'],
});

/** Cached page fetch — see the note on fetchVideos in videoService.js. */
export async function fetchImages(opts = {}) {
  return service.fetch(opts);
}
