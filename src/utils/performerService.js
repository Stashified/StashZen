/**
 * performerService.js: Fetch performers from Stash GraphQL endpoint
 *
 * Mirrors videoService.js, uses the runtime settings store for URL/key/mode.
 */

import { getSettings } from './settings.js';
import { withApiKey, isDefaultAsset } from './stashUrl.js';
import { runQuery, withoutCount } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { translateFilter } from './filterTranslate.js';
import { mockComparator } from './mockSort.js';
import { stableSort } from './randomSort.js';
import { ratingLabel } from './format.js';

// `height` is the sort value; the row carries `height_cm`. Everything else
// the Performers control offers (`name`, `rating`, `o_counter`, `play_count`,
// `last_played_at`, `birthdate`, `career_start`, `career_end`, `created_at`)
// is already a field of the mock row under the same name.
const MOCK_SORT_ALIAS = { height: 'height_cm' };

// ── Mock generator ────────────────────────────────────────
// Seeded per id, like the other two generators, and named through
// `mockPersonName` so sixty performers get sixty different names.
//
// Loaded on demand: see generateMockVideos.
async function generateMockPerformers(count = 60) {
  const { BIOS, COUNTRIES, mockPersonName } = await import('./mockLibrary.js');
  const { coverArt, makeRng } = await import('./mockArt.js');
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`performer-${i}`);
    // A separate stream: drawing these from the same source would shift every
    // value above and change the fixtures the harness pins.
    const extra = makeRng(`performer-sort-${i}`);

    return {
      id: `perf-${i + 1}`,
      name: mockPersonName(i),
      image_path: coverArt(`performer-${i}`, { portrait: true }),
      scene_count: Math.floor(rng() * 80) + 1,
      favorite: rng() > 0.85,
      // The listing query fetches this for real performers; giving the mock
      // one too keeps the gender chip on the detail page's card-first pass
      // reachable in Test mode.
      gender: ['FEMALE', 'MALE', 'NON_BINARY'][i % 3],
      rating: rng() > 0.4 ? (rng() * 4 + 6).toFixed(1) : null,
      country: COUNTRIES[Math.floor(rng() * COUNTRIES.length)],
      birthdate: `19${70 + (i % 30)}-${String((i % 12) + 1).padStart(2, '0')}`
               + `-${String((i % 28) + 1).padStart(2, '0')}`,
      height_cm: 155 + ((i * 7) % 35),
      details: BIOS[i % BIOS.length],
      created_at: now - i * 86400000,
      // Every sort the Performers control offers needs a field the comparator
      // can find. Without these the engagement and career sorts all tie:
      // a menu that looks live and does nothing.
      o_counter: Math.floor(extra() * 12),
      play_count: Math.floor(extra() * 45),
      last_played_at: extra() > 0.35 ? now - Math.floor(extra() * 120) * 86400000 : null,
      career_start: String(2004 + (i % 16)),
      career_end: extra() > 0.5 ? String(2016 + (i % 8)) : null,
    };
  });
}

// ── GraphQL query ─────────────────────────────────────────
const FIND_PERFORMERS_QUERY = `
  query FindPerformers($filter: FindFilterType, $performer_filter: PerformerFilterType) {
    findPerformers(filter: $filter, performer_filter: $performer_filter) {
      count
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
  }
`;

// Pages after the first do not read the total, see withoutCount.
const FIND_PERFORMERS_PAGE_QUERY = withoutCount(FIND_PERFORMERS_QUERY);

// One performer, in full, for the detail page. Deliberately *not* folded into
// the listing query: that runs 40 rows at a time, and nothing on a card draws
// an alias or a tattoo.
//
// `rating100` and `favorite` are the exception to "the card already has it":
// the card holds `rating`, a one-decimal display string, and a write must be
// based on the value Stash stores, not a formatted string, the same rule that
// makes `canEdit` false until the scene detail lands.
//
// `url` is deprecated on Performer and replaced by `urls`. Schema facts:
// `career_start`/`career_end` are Strings, `alias_list` and `urls` are
// `[String!]!`, and `gender` is a GenderEnum of MALE, FEMALE,
// TRANSGENDER_MALE, TRANSGENDER_FEMALE, INTERSEX, NON_BINARY.
const FIND_PERFORMER_DETAIL_QUERY = `
  query FindPerformerDetail($id: ID!) {
    findPerformer(id: $id) {
      id
      # The bio is a paragraph: fetched once for the page, never for 40 cards.
      details
      gender
      alias_list
      career_start
      career_end
      career_length
      tattoos
      measurements
      urls
      ethnicity
      hair_color
      eye_color
      weight
      piercings
      fake_tits
      death_date
      o_counter
      image_count
      gallery_count
      rating100
      favorite
      tags {
        id
        name
      }
    }
  }
`;

export function normalizePerformerDetail(p) {
  if (!p) return null;
  return {
    id: p.id,
    details: p.details || null,
    gender: p.gender || null,
    aliases: (p.alias_list || []).filter(Boolean),
    careerStart: p.career_start || null,
    careerEnd: p.career_end || null,
    careerLength: p.career_length || null,
    tattoos: p.tattoos || null,
    measurements: p.measurements || null,
    ethnicity: p.ethnicity || null,
    hairColor: p.hair_color || null,
    eyeColor: p.eye_color || null,
    weight: p.weight || null,
    piercings: p.piercings || null,
    fakeTits: p.fake_tits || null,
    deathDate: p.death_date || null,
    oCounter: p.o_counter || 0,
    imageCount: p.image_count || 0,
    galleryCount: p.gallery_count || 0,
    urls: (p.urls || []).filter(Boolean),
    tags: (p.tags || []).map(t => ({ id: t.id, name: t.name })),
    rating100: p.rating100 ?? null,
    favorite: !!p.favorite,
    writable: true,
  };
}

// Mock performers are generated per request (`perf-7`), so there is no server
// row. Echo the card's gender and leave the rest null: the page stays on its
// real render path and hides the profile block. `writable: false` keeps the
// rating and favourite controls disabled in Test mode.
function mockPerformerDetail(performer) {
  if (!performer) return null;
  return {
    id: performer.id,
    // Test mode's cards still carry it, see generateMockPerformers.
    details: performer.details || null,
    gender: performer.gender || null,
    aliases: [],
    careerStart: null,
    careerEnd: null,
    careerLength: null,
    tattoos: null,
    measurements: null,
    ethnicity: null,
    hairColor: null,
    eyeColor: null,
    weight: null,
    piercings: null,
    fakeTits: null,
    deathDate: null,
    oCounter: 0,
    imageCount: 0,
    galleryCount: 0,
    urls: [],
    tags: [],
    rating100: null,
    favorite: !!performer.favorite,
    writable: false,
  };
}

// The detail page unmounts whenever a spoke (the image or gallery hub) opens,
// so Back remounts it and asked the server for the same profile again. Cached
// per source and id, and dropped on a write or on the tab-switch sweep that
// every list cache gets (createListCache registers here).
const performerDetailCache = createListCache();

/**
 * The profile fields for one performer, given the card it was opened from:
 * Test mode needs the card because mock performers have no server row.
 *
 * Throws on transport or GraphQL errors so the page can say so.
 */
export async function loadPerformerDetail(performer) {
  if (!performer?.id) return null;
  if (getSettings().useMock) return mockPerformerDetail(performer);
  return performerDetailCache.get(
    listCacheKey('performer-detail', String(performer.id)),
    () => runQuery(FIND_PERFORMER_DETAIL_QUERY, { id: String(performer.id) })
      .then(data => normalizePerformerDetail(data?.findPerformer)),
  );
}

// The fallback for a library with no performer tags (the common case): the
// tags of the performer's scenes, counted, so the page still offers a way into
// tag-filtered scenes. A sample, not the whole filmography: the row shows the
// tags that recur, and a page is one request.
const PERFORMER_SCENE_TAGS_QUERY = `
  query PerformerSceneTags($filter: FindFilterType, $scene_filter: SceneFilterType) {
    findScenes(filter: $filter, scene_filter: $scene_filter) {
      scenes {
        tags { id name }
      }
    }
  }
`;

// Same lifetime as the profile cache above: the page remounts on the way back
// from a spoke, and the fallback row would otherwise be a second request.
const performerSceneTagsCache = createListCache();

/** Distinct tags across a sample of the performer's scenes, most frequent first. */
export async function loadPerformerSceneTags(performerId, { limit = 12, sample = 100 } = {}) {
  if (!performerId) return [];
  if (getSettings().useMock) return [];
  return performerSceneTagsCache.get(
    listCacheKey('performer-scene-tags', String(performerId), limit, sample),
    () => runQuery(PERFORMER_SCENE_TAGS_QUERY, {
      filter: { per_page: sample },
      scene_filter: {
        performers: { value: [String(performerId)], modifier: 'INCLUDES' },
      },
    }).then(data => {
      const counts = new Map();
      for (const scene of data?.findScenes?.scenes || []) {
        for (const tag of scene?.tags || []) {
          if (!tag?.id) continue;
          const key = String(tag.id);
          const row = counts.get(key) || { id: tag.id, name: tag.name, count: 0 };
          row.count += 1;
          counts.set(key, row);
        }
      }
      return [...counts.values()]
        .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
        .slice(0, limit);
    }),
  );
}

// ═══════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════

const PERFORMER_UPDATE_MUTATION = `
  mutation PerformerUpdate($input: PerformerUpdateInput!) {
    performerUpdate(input: $input) {
      id
      rating100
      favorite
    }
  }
`;

/**
 * Write a rating or favourite flag. `rating100` is Stash's 0–100 rating;
 * 0 clears it, sent as null the way Stash's own UI does.
 *
 * `PerformerUpdateInput.urls` is a single String, not the `urls` list the
 * query returns, so profile links are read-only here.
 */
export async function updatePerformer(id, patch) {
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 250));
    return { id: String(id), ...patch };
  }
  const input = { id: String(id) };
  if (patch.rating100 != null) {
    const clamped = Math.max(0, Math.min(100, Math.round(patch.rating100)));
    input.rating100 = clamped > 0 ? clamped : null;
  }
  if (patch.favorite != null) input.favorite = !!patch.favorite;
  const data = await runQuery(PERFORMER_UPDATE_MUTATION, { input });
  if (!data?.performerUpdate) throw new Error('the server returned no performer');
  clearPerformerPages();
  // The page's next mount must not paint the rating this write replaced.
  performerDetailCache.clear();
  return data.performerUpdate;
}

/**
 * Drop cached performer pages after a write. The Performers grid unmounts
 * while the detail page is open (TabContent swaps the page), so Back mounts
 * a fresh grid that fetches page 1, this is what makes the new rating or
 * favourite appear there.
 */
export function clearPerformerPages() {
  performerCache.clear();
}

export function normalizePerformer(p) {
  return {
    id: p.id,
    name: p.name,
    disambiguation: p.disambiguation,
    // Stash's placeholder path would render as a broken face.
    image_path: !p.image_path || isDefaultAsset(p.image_path)
      ? null
      : withApiKey(p.image_path),
    scene_count: p.scene_count || 0,
    favorite: !!p.favorite,
    rating: ratingLabel(p.rating100),
    country: p.country,
    gender: p.gender,
    birthdate: p.birthdate,
    height_cm: p.height_cm || null,
  };
}

// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════
const performerCache = createListCache();

/** Cached page fetch, see the note on fetchVideos in videoService.js. */
export async function fetchPerformers({
  sort = 'created_at',
  order = 'desc',
  filter = null,
  q = '',
  page = 1,
  limit = 40,
  signal,
} = {}) {
  // `random` reshuffles per request, so page 2 would overlap page 1 and the
  // no-progress stop could end the list early. See randomSort.js.
  const requestSort = stableSort(sort, 'performers', filter, q);
  return performerCache.get(
    listCacheKey('performers', requestSort, order, filter, q, page, limit),
    () => loadPerformers({ sort: requestSort, order, filter, q, page, limit, signal }),
  );
}

async function loadPerformers({
  sort = 'created_at',
  order = 'desc',
  filter = null,
  q = '',
  page = 1,
  limit = 40,
  signal,
} = {}) {
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 400));
    let performers = await generateMockPerformers(60);

    const needle = (q || '').trim().toLowerCase();
    if (needle) {
      performers = performers.filter(p => String(p.name || '').toLowerCase().includes(needle));
    }

    // `sort` may be `random_<n>`; the comparator knows only `random`.
    performers.sort(mockComparator(sort, order, MOCK_SORT_ALIAS));

    // Paginate
    const start = (page - 1) * limit;
    const slice = performers.slice(start, start + limit);

    return { performers: slice, total: performers.length, page };
  }

  const variables = {
    filter: {
      q,
      page,
      per_page: limit,
      sort,
      direction: order === 'asc' ? 'ASC' : 'DESC',
    },
    // Translated at query time, see the note in videoService.js.
    performer_filter: translateFilter(filter, 'PerformerFilterType'),
  };

  const data = await runQuery(
    page > 1 ? FIND_PERFORMERS_PAGE_QUERY : FIND_PERFORMERS_QUERY,
    variables,
    { signal },
  );
  const performers = data?.findPerformers?.performers || [];

  return {
    performers: performers.map(normalizePerformer),
    total: data?.findPerformers?.count || 0,
    page,
  };
}
