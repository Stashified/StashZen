/**
 * imageService.js — Fetch images from the Stash GraphQL endpoint.
 *
 * The loader is `entityService.js`; what is specific to images is here.
 *
 * An Image is one file and has no `folder` (a Gallery has one). This library
 * holds 31,251 of them, which is why the grid is 40 a page, appends only on
 * scroll, and nothing here preloads.
 *
 * Three URLs come back per row, three sizes of the same picture:
 *   - `paths.thumbnail` — the grid tile
 *   - `paths.preview`   — a mid-size still
 *   - `paths.image`     — full resolution, for the viewer
 * All are absolute and unkeyed and need `withApiKey()`. Tile and viewer
 * deliberately do not share a field: full-res art for every tile would make
 * this section slow.
 *
 * Test mode draws both sizes from the same seed, so the viewer's picture is
 * the tile's; `coverArt` is SVG and scales rather than blurring.
 */

import { withApiKey } from './stashUrl.js';
import { runQuery } from './stashQuery.js';
import { getSettings } from './settings.js';
import { createEntityService } from './entityService.js';
import { createListCache, listCacheKey } from './listCache.js';
import { coverArt, makeRng } from './mockArt.js';
import { filenameStem } from './format.js';

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
        visual_files {
          ... on ImageFile {
            basename
          }
        }
      }
    }
  }
`;

/**
 * A tile's caption. Image titles are empty far more often than scene titles
 * (photographs commonly have none), so the file's own name is the fallback,
 * extension dropped — see `filenameStem`.
 *
 * The first visual file is the one the tile draws, so its name is the honest
 * one. A row with neither stays null and viewers fall back to "Image".
 */
export function normalizeImage(im) {
  const basename = im?.visual_files?.[0]?.basename ?? null;
  return {
    id: im.id,
    title: im.title || filenameStem(basename),
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

// ── One image, in full, for the viewer's info panel ───────
// The listing query carries only what a tile draws, so the overlay asks for
// one row. Read-only — no rating or counter buttons, hence no cache clearing.
// `visual_files` is a union (ImageFile | VideoFile) and Image has no `files`
// field; the inline fragment keeps the query valid — asking for `files` fails
// the whole operation, which on TV is the panel's error state.
const FIND_IMAGE_INFO_QUERY = `
  query FindImageInfo($id: ID!) {
    findImage(id: $id) {
      id
      title
      date
      details
      code
      rating100
      o_counter
      studio {
        id
        name
      }
      photographer
      tags {
        id
        name
      }
      performers {
        id
        name
      }
      galleries {
        id
        title
      }
      visual_files {
        ... on ImageFile {
          basename
          size
          width
          height
        }
      }
      paths {
        thumbnail
        image
        preview
      }
    }
  }
`;

export function normalizeImageDetail(im) {
  if (!im) return null;
  const files = im.visual_files || [];
  const first = files[0] || {};
  return {
    id: im.id,
    // Same fallback as the tile, so the viewer's header and the grid agree.
    title: im.title || filenameStem(first.basename),
    date: im.date || null,
    details: im.details || null,
    code: im.code || null,
    rating100: im.rating100 ?? null,
    oCounter: im.o_counter || 0,
    studio: im.studio ? { id: im.studio.id, name: im.studio.name } : null,
    photographer: im.photographer || null,
    tags: (im.tags || []).map(t => ({ id: t.id, name: t.name })),
    performers: (im.performers || []).map(p => ({ id: p.id, name: p.name })),
    galleries: (im.galleries || []).map(g => ({ id: g.id, title: g.title })),
    fileSize: first.size ?? null,
    width: first.width ?? null,
    height: first.height ?? null,
    fileCount: files.length,
    thumbnail: withApiKey(im?.paths?.thumbnail) || null,
    image: withApiKey(im?.paths?.image) || null,
    preview: withApiKey(im?.paths?.preview) || null,
  };
}

// Test mode has no server row. The listing row already carries the file
// facts the panel shows (file_count, filesize, resolution), so derive the
// row from it rather than inventing a second mock generator.
function mockImageInfo(image) {
  const [w, h] = String(image?.resolution || '').split('x').map(Number);
  return {
    id: image?.id,
    title: image?.title || null,
    date: image?.date || null,
    details: null,
    code: null,
    rating100: image?.rating ? Math.round(Number(image.rating) * 10) : null,
    oCounter: image?.o_counter || 0,
    studio: null,
    photographer: null,
    tags: [],
    performers: [],
    galleries: [],
    fileSize: image?.filesize ?? null,
    width: Number.isFinite(w) ? w : null,
    height: Number.isFinite(h) ? h : null,
    fileCount: image?.file_count || 1,
    thumbnail: image?.image_path || null,
    image: image?.full || null,
    preview: null,
  };
}

const imageInfoCache = createListCache();

/**
 * The metadata for one image. Takes the listing row (or just the id) so Test
 * mode can answer without a server.
 *
 * Only successes are cached by `createListCache`; a failed request rejects
 * its own promise and is not remembered, so reopening the panel retries.
 */
export async function fetchImageInfo(image) {
  const id = typeof image === 'object' && image ? image.id : image;
  if (!id) return null;
  if (getSettings().useMock) return mockImageInfo(typeof image === 'object' ? image : null);
  return imageInfoCache.get(listCacheKey('image-info', String(id)), async () => {
    const data = await runQuery(FIND_IMAGE_INFO_QUERY, { id: String(id) });
    const detail = normalizeImageDetail(data?.findImage);
    if (!detail) throw new Error('the image was not found on the server');
    return detail;
  });
}
