/**
 * galleryService.js: Fetch galleries from the Stash GraphQL endpoint.
 *
 * The loader is `entityService.js`; what is specific to galleries is here.
 *
 * A Gallery is a *container* of images, a folder, where an Image is one file.
 * Gallery has `folder`, `image_count` and a nested `cover: Image`; Image has
 * none. `paths.cover` is what the card draws; the nested `cover` would pull a
 * whole Image per row for a field the paths object already answers.
 *
 * Note the sort spelling: galleries take `images_count` (plural) but
 * `performer_count` and `tag_count` (singular). Stash is not consistent, so
 * each menu was probed against its own resolver.
 */

import { withApiKey, isDefaultAsset } from './stashUrl.js';
import { createEntityService } from './entityService.js';
import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';
import { ratingLabel } from './format.js';
import { clearListCacheKind } from './listCache.js';
import { publishRowPatch } from './rowPatches.js';

const MOCK_EPOCH = Date.UTC(2024, 0, 1);

// Loaded on demand: see generateMockVideos in videoService.js.
async function generateMockGalleries() {
  const { GALLERY_TITLES, STUDIOS } = await import('./mockLibrary.js');
  const { coverArt, makeRng } = await import('./mockArt.js');
  return GALLERY_TITLES.map((title, i) => {
    const rng = makeRng(`gallery-${i}`);
    // The enrichment fields draw from their own stream so none of the pinned
    // values above move.
    const extra = makeRng(`gallery-extra-${i}`);
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
      // The 0.32 Cast sort needs a value; derived from `i`, not a new RNG draw.
      performer_age: 21 + ((i * 5) % 25),
      tag_count: Math.floor(rng() * 20),
      file_count: 1 + Math.floor(rng() * 120),
      // Folder is the one enrichment field a real library almost always has;
      // studio and photographer are sparse, which the UI must survive.
      folder: `GALLERY_${String(i + 1).padStart(3, '0')}`,
      studio: extra() > 0.4
        ? { id: `studio-${(i % STUDIOS.length) + 1}`, name: STUDIOS[i % STUDIOS.length] }
        : null,
      photographer: extra() > 0.75 ? `Photographer ${String.fromCharCode(65 + (i % 26))}` : null,
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
        studio {
          id
          name
        }
        photographer
        folder {
          basename
        }
        paths {
          cover
        }
      }
    }
  }
`;

export function normalizeGallery(g) {
  return {
    id: g.id,
    title: g.title,
    // `paths.cover` is absolute and unkeyed like every other media URL here.
    // No cover means Stash's `default=true` placeholder, not a picture.
    image_path: !g?.paths?.cover || isDefaultAsset(g.paths.cover)
      ? null
      : withApiKey(g.paths.cover) || null,
    date: g.date || null,
    rating: ratingLabel(g.rating100),
    image_count: g.image_count || 0,
    studio: g.studio ? { id: g.studio.id, name: g.studio.name } : null,
    photographer: g.photographer || null,
    folder: g?.folder?.basename || null,
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

/** Cached page fetch, see the note on fetchVideos in videoService.js. */
export async function fetchGalleries(opts = {}) {
  return service.fetch(opts);
}

// The Info sheet's detail. Gallery has no scene_count or performer_count, so
// those two counts are the fetched lists' lengths.
const FIND_GALLERY_INFO_QUERY = `
  query FindGalleryInfo($id: ID!) {
    findGallery(id: $id) {
      id
      title
      code
      details
      date
      photographer
      rating100
      organized
      image_count
      studio { id name }
      tags { id name }
      performers { id name }
      scenes { id }
      folder { basename }
    }
  }
`;

function normalizeGalleryInfo(g) {
  const refs = (list) => (list || []).map(x => ({ id: x.id, name: x.name }));
  const performers = refs(g.performers);
  return {
    title: g.title,
    code: g.code || null,
    details: g.details || null,
    date: g.date || null,
    photographer: g.photographer || null,
    rating100: g.rating100 ?? null,
    rating: ratingLabel(g.rating100),
    organized: !!g.organized,
    image_count: g.image_count || 0,
    // Derived, because Gallery does not expose either count directly.
    performer_count: performers.length,
    scene_count: (g.scenes || []).length,
    studio: g.studio ? { id: g.studio.id, name: g.studio.name } : null,
    tags: refs(g.tags),
    performers,
    folder: g?.folder?.basename || null,
  };
}

// Test mode has no server to read back: remember writes so reopening the
// sheet shows them.
const mockWritten = new Map();
const mockWrittenFor = (id) => mockWritten.get(String(id)) || {};
const recordMockWrite = (id, patch) => {
  mockWritten.set(String(id), { ...mockWrittenFor(id), ...patch });
};

/** One gallery's detail, for the long-press Info overlay. */
export async function fetchGalleryInfo(id) {
  if (getSettings().useMock) {
    const g = (await generateMockGalleries()).find(x => String(x.id) === String(id));
    if (!g) return null;
    return {
      ...normalizeGalleryInfo({
        ...g,
        // The mock row is listing-shaped; the detail normalizer reads Stash's raw
        // fields (rating100, folder { basename }).
        rating100: g.rating ? Math.round(Number(g.rating) * 10) : null,
        folder: g.folder ? { basename: g.folder } : null,
        performers: [],
        scenes: [],
        tags: [],
      }),
      ...mockWrittenFor(id),
    };
  }
  const data = await runQuery(FIND_GALLERY_INFO_QUERY, { id: String(id) });
  return data?.findGallery ? normalizeGalleryInfo(data.findGallery) : null;
}

const GALLERY_UPDATE_MUTATION = `
  mutation GalleryUpdate($input: GalleryUpdateInput!) {
    galleryUpdate(input: $input) {
      id
      rating100
      organized
    }
  }
`;

function normalizeRating100(value) {
  if (!Number.isFinite(Number(value))) {
    throw new RangeError('rating100 must be a finite number');
  }
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return clamped > 0 ? clamped : null;
}

/**
 * Write a gallery's rating and/or organised flag. Only the fields present in
 * `patch` are sent, so an organised toggle cannot clear a rating.
 */
export async function updateGallery({ id, rating100, organized }) {
  const input = { id: String(id) };
  const patch = {};
  if (rating100 !== undefined) {
    input.rating100 = normalizeRating100(rating100);
    patch.rating = ratingLabel(input.rating100);
  }
  if (organized !== undefined) {
    input.organized = !!organized;
    patch.organized = input.organized;
  }

  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 250));
    const written = {};
    if (rating100 !== undefined) {
      written.rating100 = input.rating100;
      written.rating = ratingLabel(input.rating100);
    }
    if (organized !== undefined) written.organized = input.organized;
    recordMockWrite(id, written);
    if (Object.keys(patch).length) publishRowPatch('gallery', id, patch);
    clearListCacheKind('galleries');
    return {
      id: String(id),
      ...(rating100 !== undefined ? { rating100: input.rating100 } : {}),
      ...(organized !== undefined ? { organized: input.organized } : {}),
    };
  }

  const data = await runQuery(GALLERY_UPDATE_MUTATION, { input });
  if (!data?.galleryUpdate) throw new Error('the server returned no gallery');
  const saved = data.galleryUpdate;
  const saved100 = Number.isFinite(saved.rating100) && saved.rating100 > 0
    ? saved.rating100
    : null;
  publishRowPatch('gallery', id, {
    rating: ratingLabel(saved100),
    organized: !!saved.organized,
  });
  clearListCacheKind('galleries');
  return { id: String(id), rating100: saved100, organized: !!saved.organized };
}
