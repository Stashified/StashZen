/**
 * tabConfig.js — Static configuration for the tab shell.
 *
 * Sort options are grouped for readability. Each group is a section
 * in the dropdown with a small header label.
 *
 * Shape: array of { group: string, options: [{ value, label }] }
 */

import { TAG_VIEW, STUDIO_VIEW, GALLERY_VIEW, IMAGE_VIEW } from '../components/entityViews.jsx';
import { FILTER_MODE } from '../utils/filterService.js';

// The dropdown entry standing for a filter that exists only in memory. It is
// not a saved-filter id — nothing on the server has it — so the lookup in
// `activeFilter` misses and `workingFilter` is what gets applied. Giving it a
// row in the dropdown is the honest UI: otherwise the bar reads "All" while a
// filter is plainly in force.
export const WORKING_FILTER_ID = '__working';


export const DEFAULT_CONTROLS = {
  sort:  'created_at',
  order: 'desc',
  cols:  4,
  filterId: null,
  // A filter composed in the builder and applied without saving. Stored in
  // controls rather than beside them because it is per-tab UI state with the
  // same lifetime as `filterId` — see the tab-change effect below.
  workingFilter: null,
  // What the dropdown calls it. `null` means "Custom filter" — the builder's
  // case. Activating a tag or a studio sets this instead, because it *is* the
  // more informative thing to say: landing on Scenes under a filter with no
  // indication of which tag caused it reads as the app having a mind of its
  // own, and "Custom filter" would be false.
  workingFilterLabel: null,
  // Which tab this filter was composed against. This is what makes the
  // tab-change effect idempotent — see the note there.
  workingFilterFor: null,
  // One-shot hand-off marker for the showroom's See-all tile. It names the
  // tab the tile is opening, so the tab-change effect keeps the sort that
  // `openShowroomListing` staged for that one arrival and adopts the tab's
  // default on every other. State rather than a ref because the effect's
  // updater must stay pure: StrictMode double-invokes it, and a ref consumed
  // by the first run would be gone for the second.
  sortForTab: null,
  search: '',
};

// The values are the persisted vocabulary in settings.js (`VIEW_MODES`).
// Coverflow is scene-only and deliberately absent from the other two lists:
// its mirror reflection is drawn for landscape 16:9 art, and performer and
// marker cards are not that. Left out of the list rather than shown and
// broken, so the Mode control never offers something it cannot draw.
const HOME_MODE_OPTIONS = [
  { value: 'classic',   label: 'Classic' },
  { value: 'coverflow', label: 'Coverflow' },
  { value: 'carousel',  label: 'Carousel' },
  { value: 'list',      label: 'List' },
];

const CAROUSEL_MODE_OPTIONS = [
  { value: 'classic',  label: 'Classic' },
  { value: 'carousel', label: 'Carousel' },
  { value: 'list',     label: 'List' },
];

// ── Grouped sort options ─────────────────────────────────
const SCENE_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'created_at',     label: 'Date Added' },
      { value: 'date',           label: 'Release Date' },
      { value: 'updated_at',     label: 'Date Updated' },
      { value: 'title',          label: 'Title' },
      { value: 'random',         label: 'Random' },
    ],
  },
  {
    group: 'Engagement',
    options: [
      { value: 'rating',         label: 'Rating' },
      { value: 'o_counter',      label: 'Likes' },
      { value: 'play_count',     label: 'Play Count' },
      { value: 'play_duration',  label: 'Play Duration' },
      { value: 'last_played_at', label: 'Last Played' },
    ],
  },
  {
    group: 'File',
    options: [
      { value: 'duration',       label: 'Duration' },
      { value: 'filesize',       label: 'File Size' },
      { value: 'resolution',     label: 'Resolution' },
      { value: 'bitrate',        label: 'Bitrate' },
      { value: 'framerate',      label: 'Frame Rate' },
    ],
  },
  {
    group: 'Cast',
    options: [
      { value: 'performer_age',  label: 'Performer Age' },
    ],
  },
];

const PERFORMER_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'created_at',     label: 'Date Added' },
      { value: 'name',           label: 'Name' },
      { value: 'rating',         label: 'Rating' },
    ],
  },
  {
    group: 'Engagement',
    options: [
      { value: 'o_counter',      label: 'Likes' },
      { value: 'play_count',     label: 'Play Count' },
      { value: 'last_played_at', label: 'Last Played' },
    ],
  },
  {
    group: 'Career',
    options: [
      { value: 'birthdate',      label: 'Birthdate' },
      { value: 'career_start',   label: 'Career Start' },
      { value: 'career_end',     label: 'Career End' },
      { value: 'height',         label: 'Height' },
    ],
  },
  {
    group: 'Scenes',
    options: [
      { value: 'scenes_count',   label: 'Scene Count' },
      { value: 'scenes_size',    label: 'Scenes Size' },
      { value: 'latest_scene',   label: 'Latest Scene' },
    ],
  },
];

const MARKER_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'title',      label: 'Title' },
      { value: 'created_at', label: 'Date Added' },
      { value: 'random',     label: 'Random' },
    ],
  },
  {
    group: 'Position',
    options: [
      { value: 'seconds',    label: 'Timestamp' },
      { value: 'duration',   label: 'Duration' },
    ],
  },
];

// ── The four browse-only sections ────────────────────────
//
// EVERY VALUE BELOW WAS PROBED, NOT COPIED. Stash's `SortBy` is one enum
// shared by every entity, so membership proves nothing about whether a given
// resolver honours a value — and the four do not agree with each other. Tags
// take `scenes_count` and `performers_count` (plural); Studios take
// `tag_count` and `child_count` (singular) and reject `performers_count`
// outright; Galleries and Images take `performer_count`/`tag_count` but
// `images_count`. A menu built by pattern-matching across sections fails at
// runtime with "invalid sort", so each list here was sent to its own resolver
// and kept only if it came back. The rejected ones are worth knowing because
// they are the tempting guesses: `performers_count` on Studios, and
// `files_count`, `galleries_count`, `studios_count` and `tags_count` on Images.
//
// These are the useful subset of the valid sorts, not all of them: Galleries
// and Images also accept `path`, which sorts by folder path and means nothing
// on a TV.
const TAG_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'name',       label: 'Name' },
      { value: 'created_at', label: 'Date Added' },
      { value: 'updated_at', label: 'Date Updated' },
      { value: 'random',     label: 'Random' },
    ],
  },
  {
    group: 'Content',
    options: [
      { value: 'scenes_count',         label: 'Scene Count' },
      { value: 'scene_markers_count',  label: 'Marker Count' },
      { value: 'images_count',         label: 'Image Count' },
      { value: 'galleries_count',      label: 'Gallery Count' },
    ],
  },
  {
    group: 'Related',
    options: [
      { value: 'performers_count', label: 'Performer Count' },
      { value: 'studios_count',    label: 'Studio Count' },
    ],
  },
];

const STUDIO_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'name',       label: 'Name' },
      { value: 'created_at', label: 'Date Added' },
      { value: 'updated_at', label: 'Date Updated' },
      { value: 'rating',     label: 'Rating' },
      { value: 'random',     label: 'Random' },
    ],
  },
  {
    group: 'Content',
    options: [
      { value: 'scenes_count',    label: 'Scene Count' },
      { value: 'images_count',    label: 'Image Count' },
      { value: 'galleries_count', label: 'Gallery Count' },
    ],
  },
  {
    group: 'Related',
    options: [
      { value: 'tag_count',   label: 'Tag Count' },
      { value: 'child_count', label: 'Sub-studios' },
    ],
  },
];

const GALLERY_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'title',      label: 'Title' },
      { value: 'created_at', label: 'Date Added' },
      { value: 'updated_at', label: 'Date Updated' },
      { value: 'date',       label: 'Date' },
      { value: 'rating',     label: 'Rating' },
      { value: 'random',     label: 'Random' },
    ],
  },
  {
    group: 'Content',
    options: [
      { value: 'images_count', label: 'Image Count' },
      { value: 'file_count',   label: 'File Count' },
    ],
  },
  {
    group: 'Related',
    options: [
      { value: 'performer_count', label: 'Performer Count' },
      { value: 'tag_count',       label: 'Tag Count' },
    ],
  },
];

const IMAGE_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'title',      label: 'Title' },
      { value: 'created_at', label: 'Date Added' },
      { value: 'updated_at', label: 'Date Updated' },
      { value: 'date',       label: 'Date' },
      { value: 'rating',     label: 'Rating' },
      { value: 'random',     label: 'Random' },
    ],
  },
  {
    group: 'Engagement',
    options: [
      { value: 'o_counter', label: 'Likes' },
    ],
  },
  {
    group: 'File',
    options: [
      { value: 'filesize',   label: 'File Size' },
      { value: 'resolution', label: 'Resolution' },
    ],
  },
  {
    group: 'Related',
    options: [
      { value: 'performer_count', label: 'Performer Count' },
      { value: 'tag_count',       label: 'Tag Count' },
    ],
  },
];

// Tab → descriptor, for the four sections that share `EntityPage`. Kept
// separate from TAB_CONTROL_CONFIG because that object is about the control
// bar and this one is about the listing; a section can have one without the
// other, and ImageViewer's routing below reads `activeTab` through this map
// rather than through a chain of `if`s.
export const ENTITY_VIEWS = {
  tags: TAG_VIEW,
  studios: STUDIO_VIEW,
  galleries: GALLERY_VIEW,
  images: IMAGE_VIEW,
};

// `filterMode` is the saved-filter namespace Stash files a filter under;
// `filterType` is the GraphQL input type the *criteria* belong to. They are
// different things and both are needed: the builder works in the second, the
// dropdown and the save mutation work in the first. Scene and Marker do not
// share criteria — a marker has no resolution and a scene has no
// primary_tag — so the two are genuinely separate field lists.
export const TAB_CONTROL_CONFIG = {
  // Home is the showroom (four fixed shelves, no request state of its own),
  // so it takes no controls. `showControls: false` is what hides the bar; it
  // deliberately carries no `filterMode`/`filterType`, which keeps the hidden
  // tab out of the saved-filter dropdown and the filter-origin machinery.
  home: {
    showControls: false,
  },
  // The full scene listing, moved off Home in 0.15.0. This is Home's old
  // config, unchanged: grid/carousel/coverflow, scene filters, search.
  scenes: {
    modeOptions: HOME_MODE_OPTIONS,
    sortGroups: SCENE_SORT_GROUPS,
    showOrder: true,
    showGridSize: true,
    defaultSort: 'created_at',
    filterMode: FILTER_MODE.scenes,
    filterType: 'SceneFilterType',
    showSearch: true
  },
  performers: {
    modeOptions: CAROUSEL_MODE_OPTIONS,
    sortGroups: PERFORMER_SORT_GROUPS,
    showOrder: true,
    showGridSize: true,
    // A 1,892-row name list is browsed A→Z, the same rule as Tags. Stash's
    // performer sort value is `name`, not the `title` Markers use.
    defaultSort: 'name',
    defaultOrder: 'asc',
    filterMode: FILTER_MODE.performers,
    filterType: 'PerformerFilterType',
    showSearch: true
  },
  markers: {
    modeOptions: CAROUSEL_MODE_OPTIONS,
    sortGroups: MARKER_SORT_GROUPS,
    showOrder: true,
    showGridSize: true,
    // Title was already the default sort; 0.18.4 adds the direction, which
    // was session-wide DESC and left the list Z→A.
    defaultSort: 'title',
    defaultOrder: 'asc',
    filterMode: FILTER_MODE.markers,
    filterType: 'SceneMarkerFilterType',
    showSearch: true
  },
  // The four browse-only sections. `showGridSize` is true because their listing
  // is a grid of small cards like the other three; the carousel ignores `cols`
  // and the control is hidden for it, which `showGridSize &&` at the call site
  // already handles.
  //
  // The default sorts differ, and not arbitrarily: Tags and Studios are
  // name-shaped and a 533-row name list is browsable in the way a 31,251-row
  // date list is not; Galleries and Images are file-shaped, where "newest
  // first" is the order that means something.
  //
  // `defaultSort` is adopted on **every arrival at the tab**, not only when
  // the carried sort is invalid — see the tab-change effect. That is what
  // makes the two name-shaped defaults true rather than aspirational: before
  // 0.18.0 a valid `created_at` carried in from another tab survived onto
  // Tags, so "Tags opens by Name" only held if the user had never left it.
  //
  // Tags, Performers, Markers and Studios also declare `defaultOrder: 'asc'`:
  // a name/title list is browsed A→Z. `order` is otherwise session-wide
  // (`DEFAULT_CONTROLS` says desc), so without this those tabs opened on
  // Name/Title *and* Descending — Z→A — which is what the 2026-10-17 TV pass
  // caught on Tags and the 2026-10-18 pass caught on Performers and Markers,
  // then on Studios. The arrival rule resets order alongside sort, so the asc
  // cannot leak onto a date-sorted tab.
  tags: {
    modeOptions: CAROUSEL_MODE_OPTIONS,
    sortGroups: TAG_SORT_GROUPS,
    showOrder: true,
    showGridSize: true,
    defaultSort: 'name',
    defaultOrder: 'asc',
    filterMode: FILTER_MODE.tags,
    filterType: 'TagFilterType',
    showSearch: true
  },
  studios: {
    modeOptions: CAROUSEL_MODE_OPTIONS,
    sortGroups: STUDIO_SORT_GROUPS,
    showOrder: true,
    showGridSize: true,
    defaultSort: 'name',
    defaultOrder: 'asc',
    filterMode: FILTER_MODE.studios,
    filterType: 'StudioFilterType',
    showSearch: true
  },
  galleries: {
    modeOptions: CAROUSEL_MODE_OPTIONS,
    sortGroups: GALLERY_SORT_GROUPS,
    showOrder: true,
    showGridSize: true,
    defaultSort: 'created_at',
    filterMode: FILTER_MODE.galleries,
    filterType: 'GalleryFilterType',
    showSearch: true
  },
  images: {
    modeOptions: CAROUSEL_MODE_OPTIONS,
    sortGroups: IMAGE_SORT_GROUPS,
    showOrder: true,
    showGridSize: true,
    defaultSort: 'created_at',
    filterMode: FILTER_MODE.images,
    filterType: 'ImageFilterType',
    showSearch: true
  },
};
