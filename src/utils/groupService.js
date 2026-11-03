/**
 * groupService.js: the Groups listing.
 *
 * Groups are Stash's multi-scene collection (a series, a set, an event). Like
 * tags and studios they are browsed as cards, and selecting one opens Scenes
 * filtered to it, so this service only needs the listing shape.
 *
 * `front_image_path` is non-empty even when the group has no cover: Stash
 * answers one shared SVG marked `default=true`. That flag is the only signal,
 * a 200 proves nothing, so a default front image falls back to the first
 * scene's screenshot and then to the card's monogram.
 */

import { withApiKey, isDefaultAsset } from './stashUrl.js';
import { createEntityService } from './entityService.js';
import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';
import { ratingLabel } from './format.js';

const FIND_GROUPS_QUERY = `
  query FindGroups($filter: FindFilterType, $group_filter: GroupFilterType) {
    findGroups(filter: $filter, group_filter: $group_filter) {
      count
      groups {
        id
        name
        date
        duration
        rating100
        o_counter
        scene_count
        performer_count
        front_image_path
        scenes { id paths { screenshot } }
        studio { id name }
        tags { id name }
      }
    }
  }
`;

// Same rows plus the hero's free text. `synopsis` is a paragraph per group and
// grids never draw it.
const FIND_GROUPS_HERO_QUERY = `
  query FindGroupsHero($filter: FindFilterType, $group_filter: GroupFilterType) {
    findGroups(filter: $filter, group_filter: $group_filter) {
      count
      groups {
        id
        name
        date
        duration
        rating100
        o_counter
        scene_count
        performer_count
        front_image_path
        scenes { id paths { screenshot } }
        studio { id name }
        tags { id name }
        synopsis
        director
        aliases
      }
    }
  }
`;

const MOCK_NAMES = [
  'After Hours',
  'Beach House',
  'Double Feature',
  'First Light',
  'Night Drive',
  'Studio Session',
  'Summer Set',
  'The Long Weekend',
];

async function generateMockGroups() {
  const { coverArt, makeRng } = await import('./mockArt.js');
  const { STUDIOS } = await import('./mockLibrary.js');
  return MOCK_NAMES.map((name, i) => {
    const rng = makeRng(`group-${i}`);
    const extra = makeRng(`group-extra-${i}`);
    const day = String((i * 7) % 28 + 1).padStart(2, '0');
    return {
      id: `group-${i + 1}`,
      name,
      image_path: coverArt(`group-${i}`),
      date: `2024-${String((i % 12) + 1).padStart(2, '0')}-${day}`,
      durationSeconds: 1200 + Math.floor(rng() * 5400),
      rating: rng() > 0.4 ? (rng() * 4 + 6).toFixed(1) : null,
      o_counter: Math.floor(rng() * 20),
      scene_count: 2 + Math.floor(rng() * 7),
      performer_count: 1 + Math.floor(rng() * 8),
      studio: extra() > 0.3
        ? { id: `studio-${i + 1}`, name: STUDIOS[i % STUDIOS.length] }
        : null,
      tags: [],
      synopsis: extra() > 0.5
        ? `${name} is a sample group description used to exercise the carousel blurb.`
        : null,
      director: extra() > 0.7 ? 'Sample Director' : null,
      aliases: null,
      // Both sorts exist; without a value every comparison ties and the control
      // looks broken in the one mode it is used to check controls.
      created_at: Date.UTC(2024, 0, 1) - i * 86400000,
      updated_at: Date.UTC(2024, 0, 1) - i * 3600000,
    };
  });
}

export function normalizeGroup(g) {
  // Groups without a cover all share Stash's placeholder; a scene screenshot
  // is the next real picture, and it makes each card distinct.
  const front = g.front_image_path;
  const art = !front || isDefaultAsset(front)
    ? (g.scenes || []).find(s => s?.paths?.screenshot)?.paths?.screenshot
    : front;
  return {
    id: g.id,
    name: g.name,
    image_path: withApiKey(art) || null,
    date: g.date || null,
    durationSeconds: g.duration || 0,
    rating: ratingLabel(g.rating100),
    o_counter: g.o_counter || 0,
    scene_count: g.scene_count || 0,
    performer_count: g.performer_count || 0,
    studio: g.studio ? { id: g.studio.id, name: g.studio.name } : null,
    tags: (g.tags || []).map(t => ({ id: t.id, name: t.name })),
    synopsis: g.synopsis || null,
    director: g.director || null,
    aliases: g.aliases || null,
  };
}

const service = createEntityService({
  kind: 'groups',
  root: 'findGroups',
  itemsKey: 'groups',
  filterArg: 'group_filter',
  filterType: 'GroupFilterType',
  query: FIND_GROUPS_QUERY,
  heroQuery: FIND_GROUPS_HERO_QUERY,
  normalize: normalizeGroup,
  mock: generateMockGroups,
  searchFields: ['name'],
  mockSortKey: {
    duration: 'durationSeconds',
  },
});

/** Cached page fetch, see the note on fetchVideos in videoService.js. */
export async function fetchGroups(opts = {}) {
  return service.fetch(opts);
}

// The Info sheet's detail. `containing_groups` and `sub_groups` are
// GroupDescription links: the name lives on the nested `group`.
const FIND_GROUP_INFO_QUERY = `
  query FindGroupInfo($id: ID!) {
    findGroup(id: $id) {
      id
      name
      aliases
      synopsis
      director
      date
      duration
      rating100
      o_counter
      scene_count
      performer_count
      studio { id name }
      tags { id name }
      containing_groups { group { id name } }
      sub_groups { group { id name } }
    }
  }
`;

function normalizeGroupInfo(g) {
  const refs = (list) => (list || [])
    .map(x => x?.group || x)
    .filter(Boolean)
    .map(x => ({ id: x.id, name: x.name }));
  return {
    // The name rides along so a rename since the listing wins on the sheet.
    name: g.name,
    aliases: g.aliases || null,
    synopsis: g.synopsis || null,
    director: g.director || null,
    date: g.date || null,
    durationSeconds: g.duration || 0,
    rating: ratingLabel(g.rating100),
    o_counter: g.o_counter || 0,
    scene_count: g.scene_count || 0,
    performer_count: g.performer_count || 0,
    studio: g.studio ? { id: g.studio.id, name: g.studio.name } : null,
    tags: refs(g.tags),
    containingGroups: refs(g.containing_groups),
    subGroups: refs(g.sub_groups),
  };
}

/** One group's detail, for the long-press Info overlay. */
export async function fetchGroupInfo(id) {
  if (getSettings().useMock) {
    const g = (await generateMockGroups()).find(x => String(x.id) === String(id));
    if (!g) return null;
    return normalizeGroupInfo({
      ...g,
      // The mock row is listing-shaped; the detail normalizer reads Stash's raw
      // fields (rating100, duration).
      rating100: g.rating ? Math.round(Number(g.rating) * 10) : null,
      duration: g.durationSeconds,
      containing_groups: [],
      sub_groups: [],
    });
  }
  const data = await runQuery(FIND_GROUP_INFO_QUERY, { id: String(id) });
  return data?.findGroup ? normalizeGroupInfo(data.findGroup) : null;
}
