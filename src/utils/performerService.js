/**
 * performerService.js — Fetch performers from Stash GraphQL endpoint
 *
 * Mirrors videoService.js — uses the runtime settings store for URL/key/mode.
 */

import { getSettings } from './settings.js';
import { withApiKey } from './stashUrl.js';
import { runQuery } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { translateFilter } from './filterTranslate.js';
import { BIOS, COUNTRIES, mockPersonName } from './mockLibrary.js';
import { coverArt, makeRng } from './mockArt.js';
import { mockComparator } from './mockSort.js';

// `height` is the sort value; the row carries `height_cm`. Everything else
// the Performers control offers (`name`, `rating`, `o_counter`, `play_count`,
// `last_played_at`, `birthdate`, `career_start`, `career_end`, `created_at`)
// is already a field of the mock row under the same name.
const MOCK_SORT_ALIAS = { height: 'height_cm' };

// ── Mock generator ────────────────────────────────────────
// Seeded per id, like the other two generators, and named through
// `mockPersonName` so sixty performers get sixty different names.
function generateMockPerformers(count = 60) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`performer-${i}`);
    // A second stream for the fields added for Test-mode sorting. Drawn from
    // the same source they would have shifted every value above, which would
    // change the fixtures the harness already pins for no reason.
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
      // can find. Without these the engagement and career sorts all tie —
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
        details
        height_cm
      }
    }
  }
`;

// One performer, in full, for the detail page. Deliberately *not* folded into
// the listing query above: that one runs 40 rows at a time, and nothing on a
// card draws an alias or a tattoo.
//
// `rating100` and `favorite` are the exception to "the card already has it".
// The card holds `rating`, a one-decimal display string; the page writes a
// rating back, and a write must be based on the value Stash actually stores,
// not on a string formatted for the grid. That is the same rule that makes
// `canEdit` false until the scene detail lands (see useSceneDetailData).
//
// `url` is deprecated on Performer and is replaced by `urls`; selecting the
// old field would keep the app on a path Stash has already moved away from.
//
// Every field was checked against the live 0.31.1 schema. `career_start` and
// `career_end` are Strings (not years-as-Int), `alias_list` is `[String!]!`
// so it is never null, `urls` is `[String!]!`, and `gender` is a GenderEnum
// whose six values are MALE, FEMALE, TRANSGENDER_MALE, TRANSGENDER_FEMALE,
// INTERSEX, NON_BINARY.
const FIND_PERFORMER_DETAIL_QUERY = `
  query FindPerformerDetail($id: ID!) {
    findPerformer(id: $id) {
      id
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

// Mock performers are generated per request and have ids like `perf-7`, so
// there is no server row to read. Echo the card's gender and leave the rest
// null: the page stays on its real render path and simply hides the profile
// block, the same trade `mockDetail` makes for scenes. `writable: false`
// keeps the rating and favourite controls disabled in Test mode, where the
// ids belong to generated data with no row behind them.
function mockPerformerDetail(performer) {
  if (!performer) return null;
  return {
    id: performer.id,
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

/**
 * The profile fields for one performer, given the card the user opened it
 * from. Takes the card rather than a bare id because Test mode has to answer
 * with something: mock performers have no server row and no id to read one by.
 *
 * Throws on transport or GraphQL errors so the page can say so.
 */
export async function loadPerformerDetail(performer) {
  if (!performer?.id) return null;
  if (getSettings().useMock) return mockPerformerDetail(performer);
  const data = await runQuery(FIND_PERFORMER_DETAIL_QUERY, {
    id: String(performer.id),
  });
  return normalizePerformerDetail(data?.findPerformer);
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
 * 0 clears it, which is what Stash's own UI writes.
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
    input.rating100 = Math.max(0, Math.min(100, Math.round(patch.rating100)));
  }
  if (patch.favorite != null) input.favorite = !!patch.favorite;
  const data = await runQuery(PERFORMER_UPDATE_MUTATION, { input });
  if (!data?.performerUpdate) throw new Error('the server returned no performer');
  clearPerformerPages();
  return data.performerUpdate;
}

/**
 * Drop cached performer pages after a write. The Performers grid unmounts
 * while the detail page is open (TabContent swaps the page), so Back mounts
 * a fresh grid that fetches page 1 — this is what makes the new rating or
 * favourite appear there.
 */
export function clearPerformerPages() {
  performerCache.clear();
}

function normalizePerformer(p) {
  return {
    id: p.id,
    name: p.name,
    disambiguation: p.disambiguation,
    image_path: withApiKey(p.image_path) || null,
    scene_count: p.scene_count || 0,
    favorite: !!p.favorite,
    rating: p.rating100 != null ? (p.rating100 / 10).toFixed(1) : null,
    country: p.country,
    gender: p.gender,
    birthdate: p.birthdate,
    details: p.details || null,
    height_cm: p.height_cm || null,
  };
}

// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════
const performerCache = createListCache();

/** Cached page fetch — see the note on fetchVideos in videoService.js. */
export async function fetchPerformers({
  sort = 'created_at',
  order = 'desc',
  filter = null,
  q = '',
  page = 1,
  limit = 40,
} = {}) {
  return performerCache.get(
    listCacheKey('performers', sort, order, filter, q, page, limit),
    () => loadPerformers({ sort, order, filter, q, page, limit }),
  );
}

// (this was `fetchPerformers` before the list cache was added)
async function loadPerformers({
  sort = 'created_at',
  order = 'desc',
  filter = null,
  q = '',
  page = 1,
  limit = 40,
} = {}) {
  if (getSettings().useMock) {
    await new Promise(r => setTimeout(r, 400));
    let performers = generateMockPerformers(60);

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
    // Translated at query time — see the note in videoService.js.
    performer_filter: translateFilter(filter, 'PerformerFilterType'),
  };

  const data = await runQuery(FIND_PERFORMERS_QUERY, variables);
  const performers = data?.findPerformers?.performers || [];

  return {
    performers: performers.map(normalizePerformer),
    total: data?.findPerformers?.count || 0,
    page,
  };
}
