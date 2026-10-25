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
// not a saved-filter id, so `activeFilter` misses and `workingFilter` applies;
// the row keeps the bar from reading "All" while a filter is in force.
export const WORKING_FILTER_ID = '__working';


export const DEFAULT_CONTROLS = {
  sort:  'created_at',
  order: 'desc',
  cols:  4,
  filterId: null,
  // A filter composed in the builder and applied without saving. Per-tab UI
  // state with the same lifetime as `filterId` — see the tab-change effect.
  workingFilter: null,
  // What the dropdown calls it. `null` means "Custom filter"; activating a tag
  // or studio sets its name, because landing on Scenes under a filter with no
  // indication of which tag caused it reads as the app's own doing.
  workingFilterLabel: null,
  // Which tab this filter was composed against — what makes the tab-change
  // effect idempotent.
  workingFilterFor: null,
  // One-shot hand-off marker for the showroom's See-all tile: it names the tab
  // being opened, so the tab-change effect keeps its staged sort for that one
  // arrival. State, not a ref, because the effect's updater must stay pure
  // under StrictMode's double invocation.
  sortForTab: null,
  search: '',
};

// The values are the persisted vocabulary in settings.js (`VIEW_MODES`).
// Coverflow is scene-only: its mirror reflection is drawn for landscape 16:9
// art and the other cards are not that, so it is omitted rather than offered
// broken.
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
// Every value was probed against its own resolver, not copied: Stash's `SortBy`
// is one enum shared by every entity, so membership proves nothing. Tags take
// `scenes_count`/`performers_count` (plural); Studios take
// `tag_count`/`child_count` (singular) and reject `performers_count`; Galleries
// and Images take `performer_count`/`tag_count` but `images_count`. Rejected
// guesses include `files_count`, `galleries_count`, `studios_count` and
// `tags_count` on Images; pattern-matching fails at runtime with "invalid sort".
//
// A useful subset, not all: Galleries and Images also accept `path`, which
// means nothing on a TV.
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

// Tab → descriptor for the four sections that share `EntityPage`. Separate from
// TAB_CONTROL_CONFIG because a section can have a control bar without being one
// of these; ImageViewer routes `activeTab` through this map, not a chain of `if`s.
export const ENTITY_VIEWS = {
  tags: TAG_VIEW,
  studios: STUDIO_VIEW,
  galleries: GALLERY_VIEW,
  images: IMAGE_VIEW,
};

// `filterMode` is the saved-filter namespace; `filterType` is the GraphQL input
// type the *criteria* belong to. Both are needed: the builder works in the
// second, the dropdown and save mutation in the first. Scene and Marker do not
// share criteria (a marker has no resolution, a scene no primary_tag), so their
// field lists differ.
export const TAB_CONTROL_CONFIG = {
  // Home is the showroom (four fixed shelves, no request state), so it takes no
  // controls; `showControls: false` hides the bar. Carrying no
  // `filterMode`/`filterType` keeps it out of the saved-filter dropdown and the
  // filter-origin machinery.
  home: {
    showControls: false,
  },
  // The full scene listing, moved off Home in 0.15.0: grid/carousel/coverflow,
  // scene filters, search.
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
    // A 1,892-row name list is browsed A→Z, as Tags. The value is `name`, not
    // the `title` Markers use.
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
    // Title was already the default sort; without the direction, `order` is
    // session-wide DESC and the list opens Z→A.
    defaultSort: 'title',
    defaultOrder: 'asc',
    filterMode: FILTER_MODE.markers,
    filterType: 'SceneMarkerFilterType',
    showSearch: true
  },
  // The four browse-only sections. `showGridSize` is true because their listing
  // is a grid of small cards; the carousel ignores `cols` and the call site
  // hides the control for it.
  //
  // Tags and Studios are name-shaped — a 533-row name list is browsable, a
  // 31,251-row date list is not — while Galleries and Images are file-shaped,
  // where "newest first" means something.
  //
  // `defaultSort` is adopted on **every arrival at the tab**, not only when the
  // carried sort is invalid (see the tab-change effect) — otherwise a valid
  // `created_at` carried in from another tab would survive onto Tags and
  // "Tags opens by Name" would only hold if the user had never left it.
  //
  // The name-shaped tabs also declare `defaultOrder: 'asc'`: `order` is
  // session-wide (`DEFAULT_CONTROLS` says desc), so without it they opened
  // Name/Title *Descending*. Order resets alongside sort, so asc cannot leak
  // onto a date-sorted tab.
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
