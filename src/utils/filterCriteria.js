/**
 * filterCriteria.js — what the generated schema cannot know.
 *
 * `stashFilterSchema.js` knows every field, its GraphQL input type, the fields
 * each criterion declares and its enums. It does not know that `rating100`
 * means "Rating" on a 0–10 scale, or that its multi-select offers the Tag
 * list. That is this file.
 *
 * THE DISCIPLINE. Nothing here enumerates *fields*: the editor is derived from
 * the declared input type name, and modifiers from the fields that type
 * declares. A field list is how the `has_markers`/`is_missing` bug happened —
 * both are `String` in the schema while the `organized` beside them is
 * `Boolean`. Add a field to Stash and regenerate: it appears here with no edit,
 * and a wrong type makes `coverage()` fail loudly rather than shipping a 422.
 *
 * WHAT "REACHABLE" MEANS. Every field is either buildable or deliberately
 * listed as not, with a user-readable reason. `coverage()` is the assertion;
 * `scripts/verify-criteria.mjs` runs it against every filter type the app can
 * send, so "all fields" is proved rather than claimed.
 */

import {
  FILTER_TYPES,
  CRITERION_FIELDS,
  CRITERIA_WITHOUT_MODIFIER,
  LIST_VALUED_CRITERIA,
  ENUMS,
  FILTER_TYPE_NAMES,
} from './stashFilterSchema.js';

const BASE = (t) => String(t).replace(/[[\]!]/g, '');

// ── Editor kinds ──────────────────────────────────────────
//
// Named for the widget, not the type: Int and Float share `number`, while one
// type can need two editors (a phash distance is a value plus a distance).
export const EDITOR = {
  TEXT: 'text',
  NUMBER: 'number',
  DATE: 'date',
  TIMESTAMP: 'timestamp',
  ENUM: 'enum',
  BOOLEAN: 'boolean',
  TRI: 'tri',
  MULTI: 'multi',
  HIERARCHICAL: 'hierarchical',
  PHASH: 'phash',
  STASH_ID: 'stashid',
  STASH_IDS: 'stashids',
};

/**
 * criterionTypeName → editor kind. This table replaces a field list, so it is
 * deliberately keyed by *type*.
 *
 * The bare `Boolean` and `String` scalars are not interchangeable: `organized`
 * is a real Boolean, while `has_markers`/`is_missing` are String and
 * tri-state in practice ("true" / "false" / unset). Coercing the latter to a
 * boolean is the recorded bug, so they get their own editor.
 */
const EDITOR_BY_TYPE = {
  StringCriterionInput: EDITOR.TEXT,
  IntCriterionInput: EDITOR.NUMBER,
  FloatCriterionInput: EDITOR.NUMBER,
  DateCriterionInput: EDITOR.DATE,
  TimestampCriterionInput: EDITOR.TIMESTAMP,
  ResolutionCriterionInput: EDITOR.ENUM,
  GenderCriterionInput: EDITOR.ENUM,
  // `circumcised` is enum-valued but its `value` is a *list* (see
  // LIST_VALUED_CRITERIA), so it takes several answers: same editor,
  // `listValued` set.
  CircumcisionCriterionInput: EDITOR.ENUM,
  MultiCriterionInput: EDITOR.MULTI,
  HierarchicalMultiCriterionInput: EDITOR.HIERARCHICAL,
  PhashDistanceCriterionInput: EDITOR.PHASH,
  StashIDCriterionInput: EDITOR.STASH_ID,
  StashIDsCriterionInput: EDITOR.STASH_IDS,
  Boolean: EDITOR.BOOLEAN,
  String: EDITOR.TRI,
};

/** The enum a criterion's value is drawn from, when it has one. */
const ENUM_BY_TYPE = {
  ResolutionCriterionInput: 'ResolutionEnum',
  GenderCriterionInput: 'GenderEnum',
  CircumcisionCriterionInput: 'CircumcisedEnum',
};

// ── Unreachable, with the reason shown ────────────────────
//
// Listed in the builder rather than hidden: "all fields" silently meaning
// "all fields except seven" is worse than saying which and why.
const NESTED_REASON =
  'Combining filters — a tree editor is its own project, and a half-built one that silently drops a branch is worse than none.';
const CUSTOM_FIELD_REASON =
  'Custom fields — the value type depends on the field definition, which this app does not fetch.';
const EXOTIC_REASON = {
  DuplicationCriterionInput:
    'Duplication detection — needs a phash and a distance the app has no way to choose.',
  FileDuplicationCriterionInput:
    'Duplication detection — as above.',
  OrientationCriterionInput:
    'Orientation — a spatial/VR flag with no equivalent control in this app.',
};

/**
 * Why a field cannot be built, or null if it can. `fieldType` is the GraphQL
 * type NAME as it appears in FILTER_TYPES.
 */
export function unreachableReason(field, fieldType) {
  if (field === 'AND' || field === 'OR' || field === 'NOT') return NESTED_REASON;
  const base = BASE(fieldType);
  if (FILTER_TYPE_NAMES.has(base)) return NESTED_REASON;
  if (String(fieldType).startsWith('[')) return CUSTOM_FIELD_REASON;
  if (EXOTIC_REASON[base]) return EXOTIC_REASON[base];
  return null;
}

/** The editor kind for a filter field, or null when it is not buildable. */
export function editorFor(field, fieldType) {
  if (unreachableReason(field, fieldType)) return null;
  return EDITOR_BY_TYPE[BASE(fieldType)] || null;
}

// ── Modifiers ─────────────────────────────────────────────
//
// Derived from the criterion's declared shape, then checked against the real
// CriterionModifier enum. Two rules carry the weight: BETWEEN needs a second
// operand, so it is offered only where the type declares `value2` (elsewhere
// the translator drops the criterion as empty); and a type with no `modifier`
// field gets none — emitting one is a 422.
const MODIFIERS = {
  [EDITOR.TEXT]: ['EQUALS', 'NOT_EQUALS', 'INCLUDES', 'EXCLUDES', 'MATCHES_REGEX', 'NOT_MATCHES_REGEX', 'IS_NULL', 'NOT_NULL'],
  [EDITOR.NUMBER]: ['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN', 'BETWEEN', 'NOT_BETWEEN', 'IS_NULL', 'NOT_NULL'],
  [EDITOR.DATE]: ['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN', 'BETWEEN', 'NOT_BETWEEN', 'IS_NULL', 'NOT_NULL'],
  [EDITOR.TIMESTAMP]: ['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN', 'BETWEEN', 'NOT_BETWEEN', 'IS_NULL', 'NOT_NULL'],
  [EDITOR.ENUM]: ['EQUALS', 'NOT_EQUALS', 'IS_NULL', 'NOT_NULL'],
  [EDITOR.MULTI]: ['INCLUDES', 'EXCLUDES', 'INCLUDES_ALL', 'EQUALS', 'NOT_EQUALS'],
  [EDITOR.HIERARCHICAL]: ['INCLUDES', 'EXCLUDES', 'INCLUDES_ALL', 'EQUALS', 'NOT_EQUALS'],
  [EDITOR.BOOLEAN]: ['EQUALS'],
  [EDITOR.TRI]: ['EQUALS'],
  [EDITOR.PHASH]: ['EQUALS', 'NOT_EQUALS'],
  [EDITOR.STASH_ID]: ['EQUALS', 'NOT_EQUALS', 'IS_NULL', 'NOT_NULL'],
  [EDITOR.STASH_IDS]: ['EQUALS', 'NOT_EQUALS', 'IS_NULL', 'NOT_NULL'],
};

/** Modifiers that need no operand. */
export const NULLARY = new Set(['IS_NULL', 'NOT_NULL']);

/** Modifiers that take a second operand (`value2`). */
const RANGE = new Set(['BETWEEN', 'NOT_BETWEEN']);

/**
 * The modifiers a given field can actually take.
 *
 * The field's own type is enough: `BASE` strips the input suffix, resolving
 * the ambiguity that matters — `String` is both `StringCriterionInput` and the
 * bare `String` scalar, and those share no declared fields. Do not add the
 * enclosing filter type as a parameter; it has no effect.
 */
export function modifiersFor(field, fieldType) {
  const editor = editorFor(field, fieldType);
  if (!editor) return [];

  const base = BASE(fieldType);
  if (CRITERIA_WITHOUT_MODIFIER.has(base)) return [];

  const declared = CRITERION_FIELDS[base] || [];
  const all = MODIFIERS[editor] || [];

  return all.filter((m) => {
    if (RANGE.has(m) && !declared.includes('value2')) return false;
    // Every emitted modifier must be a real enum member, catching a typo here
    // rather than as a 422 on the TV.
    return ENUMS.CriterionModifier.includes(m);
  });
}

/** Does this editor's value come from an enum? */
export function enumFor(fieldType) {
  return ENUMS[ENUM_BY_TYPE[BASE(fieldType)]] || null;
}

// ── Labels ────────────────────────────────────────────────
const ACRONYMS = new Set(['id', 'url', 'cm', 'hd', 'zip', 'phash', 'oshash']);

/**
 * `audio_codec` → "Audio codec". The fallback for every field without a
 * hand-written label, so it must be good rather than clever.
 */
export function humanise(field) {
  return field
    .split('_')
    .map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Labels where the mechanical form is wrong or ambiguous. Keyed by field name:
 * these are exceptions, not a mapping.
 */
const LABELS = {
  rating100: 'Rating',
  o_counter: 'O count',
  play_count: 'Play count',
  play_duration: 'Play duration',
  resume_time: 'Resume at',
  last_played_at: 'Last played',
  is_missing: 'Missing',
  is_zip: 'Zip',
  has_markers: 'Has markers',
  has_chapters: 'Has chapters',
  organized: 'Organised',
  favorite: 'Favourite',
  filter_favorites: 'Favourite',
  ignore_auto_tag: 'Ignore auto-tag',
  height_cm: 'Height',
  weight: 'Weight',
  stash_id_endpoint: 'Stash ID',
  stash_ids_endpoint: 'Stash IDs',
  stash_id_count: 'Stash ID count',
  phash_distance: 'Perceptual hash distance',
  average_resolution: 'Average resolution',
  performer_favorite: 'Performer is a favourite',
  performer_tags: 'Performer tags',
  performer_age: 'Performer age',
  performer_count: 'Performers',
  scene_count: 'Scenes',
  image_count: 'Images',
  gallery_count: 'Galleries',
  group_count: 'Groups',
  marker_count: 'Markers',
  movie_count: 'Movies',
  studio_count: 'Studios',
  tag_count: 'Tags',
  child_count: 'Children',
  parent_count: 'Parents',
  sub_group_count: 'Sub-groups',
  containing_group_count: 'Containing groups',
  video_codec: 'Video codec',
  audio_codec: 'Audio codec',
  interactive_speed: 'Interactive speed',
  birth_year: 'Birth year',
  death_year: 'Death year',
  career_length: 'Career length',
  career_start: 'Career start',
  career_end: 'Career end',
  eye_color: 'Eye colour',
  hair_color: 'Hair colour',
  fake_tits: 'Breasts',
  tattoos: 'Tattoos',
  piercings: 'Piercings',
  circumcised: 'Circumcised',
  penis_length: 'Length',
  scene_date: 'Scene date',
  scene_tags: 'Scene tags',
  scene_created_at: 'Scene added',
  scene_updated_at: 'Scene updated',
  parent_folder: 'Parent folder',
  sort_name: 'Sort name',
  equivalent_to: 'Also',
};

export function labelFor(field) {
  return LABELS[field] || humanise(field);
}

// ── Entity sources for multi-selects ──────────────────────
//
// Which list the picker draws from, derived from the field name with the
// aliases that do not share their entity's word: a Tag's `parents` are tags,
// a group's `sub_groups` are groups.
const ENTITY_ALIASES = {
  parents: 'tags',
  children: 'tags',
  performer_tags: 'tags',
  scene_tags: 'tags',
  containing_groups: 'groups',
  sub_groups: 'groups',
  parent_folder: 'folders',
  folders: 'folders',
};

const ENTITIES = new Set([
  'tags', 'performers', 'studios', 'galleries', 'images', 'movies',
  'groups', 'scenes', 'markers', 'folders', 'files',
]);

/**
 * The entity a multi-select draws from, or null when there isn't one.
 *
 * `filterTypeName` is needed because a field name is not always enough: a
 * tag's `parents` are tags, a studio's `parents` are studios. Without this the
 * Studio builder offers the Tag picker and writes tag ids into a Studio
 * criterion — the server accepts it and returns nothing, which looks like an
 * empty library rather than a bad query. Other aliases mean the same thing in
 * every filter type.
 */
export function entitySource(field, filterTypeName) {
  if (field === 'parents' && filterTypeName === 'StudioFilterType') return 'studios';
  if (ENTITY_ALIASES[field]) return ENTITY_ALIASES[field];
  return ENTITIES.has(field) ? field : null;
}

// ── The Common group ──────────────────────────────────────
//
// ~12 pinned criteria per type; everything else is reachable under "All
// fields". This is only about which are worth not scrolling for.
export const COMMON = {
  SceneFilterType: [
    'title', 'path', 'tags', 'performers', 'studios', 'rating100',
    'organized', 'has_markers', 'date', 'o_counter', 'duration', 'resolution',
  ],
  SceneMarkerFilterType: [
    'tags', 'performers', 'scenes', 'scene_tags', 'duration',
    'created_at', 'updated_at', 'scene_date',
  ],
  PerformerFilterType: [
    'name', 'tags', 'studios', 'gender', 'rating100', 'filter_favorites',
    'country', 'ethnicity', 'hair_color', 'eye_color', 'height_cm', 'scene_count',
  ],
  GalleryFilterType: [
    'title', 'path', 'tags', 'performers', 'studios', 'rating100',
    'organized', 'date', 'image_count', 'is_zip',
  ],
  ImageFilterType: [
    'title', 'path', 'tags', 'performers', 'studios', 'rating100',
    'organized', 'date', 'o_counter', 'resolution',
  ],
  TagFilterType: [
    'name', 'parents', 'children', 'favorite', 'scene_count', 'image_count',
    'gallery_count', 'performer_count', 'studio_count', 'marker_count',
  ],
  StudioFilterType: [
    'name', 'parents', 'tags', 'favorite', 'rating100', 'scene_count',
    'image_count', 'gallery_count', 'child_count',
  ],
};

// ── The descriptor the builder renders ────────────────────

/**
 * Every field of `filterTypeName`, as a descriptor:
 *   { field, type, editor, label, common, reason, modifierOptions,
 *     enumOptions, entity, hierarchical }
 *
 * `reason` is set exactly when `editor` is null; the builder renders those in
 * a disabled group. Nothing is dropped.
 */
export function criteriaFor(filterTypeName) {
  const fields = FILTER_TYPES[filterTypeName];
  if (!fields) return [];

  const common = COMMON[filterTypeName] || [];

  return Object.keys(fields).sort().map((field) => {
    const type = fields[field];
    const editor = editorFor(field, type);
    const base = BASE(type);

    return {
      field,
      type,
      editor,
      label: labelFor(field),
      common: common.includes(field),
      reason: editor ? null : unreachableReason(field, type),
      modifierOptions: editor ? modifiersFor(field, type) : [],
      enumOptions: editor === EDITOR.ENUM ? (enumFor(type) || []) : null,
      entity: editor === EDITOR.MULTI || editor === EDITOR.HIERARCHICAL
        ? entitySource(field, filterTypeName)
        : null,
      hierarchical: editor === EDITOR.HIERARCHICAL,
      // `value2` is declared by Int/Float/Date/Timestamp, where a range is
      // meaningful. Read off the schema, not from a list.
      supportsRange: (CRITERION_FIELDS[base] || []).includes('value2'),
      // A criterion whose `value` is declared as a list takes several
      // answers. Schema-derived: `circumcised` and orientation (unreachable).
      listValued: LIST_VALUED_CRITERIA.has(base),
    };
  });
}

/**
 * Reachable vs not, for the verify script and the builder's summary line.
 * Every field lands in exactly one list — the assertion — so a new Stash field
 * with an unfamiliar type fails it rather than disappearing.
 */
export function coverage(filterTypeName) {
  const all = criteriaFor(filterTypeName);
  return {
    reachable: all.filter((c) => c.editor),
    unreachable: all.filter((c) => !c.editor),
    // A type unknown to EDITOR_BY_TYPE with a null reason would be silently
    // unbuildable; there is no such case today, and this reports it if one
    // appears.
    unexplained: all.filter((c) => !c.editor && !c.reason),
  };
}
