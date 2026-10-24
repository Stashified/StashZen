/**
 * filterTranslate.js — Stash's *saved-filter* format → the GraphQL input shape.
 *
 * WHY THIS EXISTS. `findSavedFilters` returns each saved filter's `object_filter`
 * in the shape Stash's own frontend stores, which is NOT the shape its GraphQL
 * API accepts. Until this module existed the object was forwarded verbatim
 * (`App.jsx` → `objectFilter` → `scene_filter`), so 22 of the user's 24 saved
 * filters failed with an opaque HTTP 422, and the 2 that validated returned
 * nothing. Both failure modes are silent to the user — an empty grid.
 *
 * There is exactly one modifier enum (`CriterionModifier`), so modifiers pass
 * through 1:1; only the *envelopes* differ. Four translations cover every
 * field in the real data:
 *
 *   {modifier, value:{value:N}}                  → {value:N, modifier}          Int / Float / timestamp / date
 *   {modifier, value:{items:[{id,label}],        → {value:["id"], modifier,     tags, performers
 *                    excluded:[], depth}}           excludes:["id"], depth}
 *   {modifier, value:{distance, value}}          → {value, modifier, distance}  phash_distance
 *   {modifier, value:{endpoint, stashID}}        → {endpoint, stash_id, modifier}
 *
 * plus one that is a plain type error rather than a shape error: a Boolean field
 * (`organized`) is stored as the *string* `"false"` inside the same envelope,
 * so it has to be unwrapped and coerced or GraphQL rejects it.
 *
 * THE QUOTING TRAP. Stash's UI wraps a criterion value in literal double quotes
 * when it contains a space, so 14 of the 20 `path` criteria stored here read
 * `"\"/media/library/…/Some Folder\""`. Sent as-is those *validate* and match zero rows —
 * the single worst failure mode in this file's problem space, because nothing
 * errors. Measured: such a filter returns 0 scenes quoted and a full page de-quoted.
 *
 * DISPATCH IS SCHEMA-DRIVEN, NEVER A FIELD LIST. Each field's GraphQL type comes
 * from the generated `stashFilterSchema.js`. That is what distinguishes the five
 * scalar fields from each other: `organized`, `interactive` and
 * `performer_favorite` are `Boolean`, while `has_markers` and `is_missing` are
 * `String` and must NOT be coerced to booleans. It is also what decides whether a
 * multi-select takes `depth` (`HierarchicalMultiCriterionInput`) or would be
 * rejected for including it (`MultiCriterionInput`).
 *
 * UNKNOWN INPUT PASSES THROUGH. A field this module does not recognise, or a
 * value whose shape it does not match, is forwarded untouched. The alternative —
 * dropping it — would silently discard a filter condition, which is the exact
 * class of bug this file exists to fix. A criterion saved by a newer Stash
 * therefore degrades to today's behaviour instead of quietly widening the filter.
 *
 * IDEMPOTENT. Filters built in-code (`PerformerDetailPage` passes
 * `{performers: {value:[id], modifier:'INCLUDES'}}`, already GraphQL-shaped)
 * survive a trip through here unchanged, which is why the services can translate
 * unconditionally at query time instead of at every call site.
 *
 * WHERE IT IS CALLED. In the three service loaders, immediately before building
 * the request variables — deliberately not in `filterService`, so that the raw
 * object stays in the `listCache` keys and cache identity is unchanged.
 */

import {
  FILTER_TYPES,
  FILTER_TYPE_NAMES,
  CRITERION_FIELDS,
  CRITERIA_WITHOUT_MODIFIER,
  LIST_VALUED_CRITERIA,
} from './stashFilterSchema.js';

const DEV = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;

// Warn once per (filter type, key) so a single bad filter can't flood the
// console on every keystroke of a search.
const warned = new Set();
function warnOnce(msg) {
  if (!DEV || warned.has(msg)) return;
  warned.add(msg);
  console.warn('[filterTranslate]', msg);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Stash's UI quotes a criterion value that contains a space. Exactly one
 * surrounding pair is removed; there is no escaping to undo, because the UI
 * adds one pair and never re-quotes an already-quoted value.
 *
 * Exported for the verify script and for tests.
 */
export function stripWrappingQuotes(s) {
  if (typeof s !== 'string' || s.length < 2) return s;
  if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  return s;
}

// `IS_NULL` / `NOT_NULL` take no operand, so an empty value beside them is
// normal rather than a sign of an unset criterion. Every other modifier needs
// one.
const NULLARY_MODIFIERS = new Set(['IS_NULL', 'NOT_NULL']);

// ── criterion values ──────────────────────────────────────

/** `[{id, label}]` (frontend) or `["id"]` (GraphQL) → `["id"]`. */
function toIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => (isPlainObject(x) ? x.id ?? x.value : x))
    .filter(x => x != null);
}

/** Coerce a scalar for `typeName`'s `value` field. */
function coerceScalar(typeName, v) {
  // Orientation and circumcision declare `value` as a list, so a bare enum has
  // to be wrapped. A value that already arrives as a list is mapped through
  // `toIds`, which is the identity for a plain id array and unwraps `{id,label}`
  // entries if a caller hands those over instead.
  if (LIST_VALUED_CRITERIA.has(typeName)) {
    if (Array.isArray(v)) return toIds(v);
    return [typeof v === 'string' ? stripWrappingQuotes(v) : v];
  }
  return typeof v === 'string' ? stripWrappingQuotes(v) : v;
}

/**
 * A `Boolean` field. Stored as `{modifier:'EQUALS', value:'false'}` — the value
 * is a *string*, which GraphQL rejects for a Boolean field. Returns `undefined`
 * for a value it can't interpret, which the caller treats as "drop the field".
 */
function coerceBoolean(v) {
  const raw = isPlainObject(v) ? v.value : v;
  if (raw === true || raw === false) return raw;
  if (raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === 'false' || raw === 0 || raw === '0') return false;
  return undefined;
}

/**
 * A bare `String` field (`has_markers`, `is_missing`). These also arrive inside
 * a criterion envelope, but the GraphQL field has no modifier slot, so one is
 * dropped. That is safe rather than lossy in practice: Stash's own filter for
 * these encodes the choice in the value ("true" / "false") and treats the
 * modifier as redundant.
 */
function coerceString(v) {
  const raw = isPlainObject(v) ? v.value : v;
  return typeof raw === 'string' ? stripWrappingQuotes(raw) : raw;
}

/**
 * Translate one criterion envelope. Returns `undefined` for a criterion that
 * constrains nothing (see the empty-value note below).
 */
function translateCriterion(c, typeName) {
  if (!isPlainObject(c)) return c;

  const modifier = c.modifier;
  const v = c.value;
  const out = {};

  if (isPlainObject(v)) {
    // Multi-select. The frontend nests the payload and calls the exclusion list
    // `excluded`; GraphQL hoists both to the criterion and calls it `excludes`.
    if (Array.isArray(v.items) || Array.isArray(v.excluded)) {
      out.value = toIds(v.items);
      const excluded = toIds(v.excluded);
      if (excluded.length) out.excludes = excluded;
      if (v.depth != null) out.depth = v.depth;
    }
    // phash_distance: {distance, value} → hoisted, same names.
    else if (v.distance != null && v.value !== undefined) {
      out.value = coerceScalar(typeName, v.value);
      out.distance = v.distance;
    }
    // Stash ID: {endpoint, stashID} → `stash_id` (and the plural variant).
    else if (v.endpoint !== undefined) {
      out.endpoint = v.endpoint;
      if (v.stashIDs !== undefined) out.stash_ids = v.stashIDs;
      else if (v.stashID !== undefined) out.stash_id = v.stashID;
    }
    // The common wrapper: {value} / {value, value2}.
    else if (v.value !== undefined) {
      out.value = coerceScalar(typeName, v.value);
      if (v.value2 !== undefined) out.value2 = coerceScalar(typeName, v.value2);
    }
    // Already flat (DuplicationCriterionInput is stored in GraphQL shape) or a
    // shape from a newer Stash we don't model — forward it.
    else {
      Object.assign(out, v);
    }
  } else if (v !== undefined) {
    out.value = coerceScalar(typeName, v);
  }

  if (modifier !== undefined && !CRITERIA_WITHOUT_MODIFIER.has(typeName)) {
    out.modifier = modifier;
  }

  // Carry across any declared key already sitting at the criterion's top level.
  //
  // This is the fixed-point half of the function. The frontend shape buries
  // `depth`, `distance` and `endpoint` *inside* `value`, while GraphQL hoists
  // them to the criterion; a criterion that has already been translated —
  // whether by a previous pass or by a caller who built it in code — therefore
  // has them outside, where the shape analysis above never looks. Without this
  // step a second translation silently drops them (measured: `tags … depth`
  // and `phash_distance … distance` both lost their hoisted key). The
  // `out[k] === undefined` guard keeps it from overriding anything just built.
  const declared = CRITERION_FIELDS[typeName];
  if (declared) {
    for (const key of declared) {
      if (key !== 'value' && key !== 'value2' && key !== 'modifier'
        && c[key] !== undefined && out[key] === undefined) {
        out[key] = c[key];
      }
    }
  }

  // Prune anything the target type doesn't declare. This is what stops a stray
  // `depth` (which only the Hierarchical variants accept) from turning the whole
  // query into a 422 — and it is derived from the live schema, not a guess.
  if (declared) {
    for (const key of Object.keys(out)) {
      if (!declared.includes(key)) {
        warnOnce(`${typeName} has no field "${key}" — dropped (value came from a newer or unknown envelope)`);
        delete out[key];
      }
    }
  }

  // A criterion that constrains nothing is dropped rather than sent. `INCLUDES ""`
  // matches every row (substring match against the empty string) so sending it
  // silently *widens* the filter; `EXCLUDES ""` matches none, silently emptying
  // it. Neither is what an unset value means to the user, and Stash's UI never
  // intends to save one — an empty box is just echoed back into the saved object.
  //
  // An empty value is only "nothing" when there are no exclusions either. A
  // multi-select can legitimately carry `items: []` beside a non-empty
  // `excluded` list, and that criterion *does* constrain the result — dropping
  // it because the include side is empty silently showed the rows the user had
  // excluded.
  const emptyValue = out.value === ''
    || (Array.isArray(out.value) && out.value.length === 0);
  const hasExcludes = Array.isArray(out.excludes) && out.excludes.length > 0;
  if (!NULLARY_MODIFIERS.has(out.modifier) && emptyValue && !hasExcludes) return undefined;

  return out;
}

// ── filter objects ────────────────────────────────────────

/**
 * Translate one field. Returns `undefined` when the field should be omitted.
 */
function translateField(value, fieldType) {
  if (value == null) return undefined;

  // A nested filter (AND / OR / NOT, or `*_filter`). Recent Stash accepts a list
  // of sub-filters here as well as a single object.
  if (FILTER_TYPE_NAMES.has(fieldType)) {
    if (Array.isArray(value)) {
      const list = value.map(v => (isPlainObject(v) ? translateObject(v, fieldType) : v)).filter(Boolean);
      return list.length ? list : undefined;
    }
    if (!isPlainObject(value)) return value;
    const nested = translateObject(value, fieldType);
    return Object.keys(nested).length ? nested : undefined;
  }

  if (fieldType === 'Boolean') return coerceBoolean(value);
  if (fieldType === 'String') return coerceString(value);

  // A list of input objects (custom_fields). Stored shape is already close
  // enough that guessing a rewrite would be worse than forwarding it.
  if (fieldType.startsWith('[')) return value;

  return translateCriterion(value, fieldType);
}

function translateObject(obj, typeName) {
  const fieldMap = FILTER_TYPES[typeName];
  const out = {};

  for (const key of Object.keys(obj)) {
    const fieldType = fieldMap?.[key];

    if (!fieldType) {
      // Unknown field: forward it. Dropping would silently remove a condition.
      warnOnce(`${typeName}.${key} is not in the schema snapshot — passed through untranslated`);
      out[key] = obj[key];
      continue;
    }

    const translated = translateField(obj[key], fieldType);
    if (translated !== undefined) out[key] = translated;
  }

  return out;
}

/**
 * Translate a stored `object_filter` into the GraphQL input object for
 * `filterTypeName` (`SceneFilterType`, `SceneMarkerFilterType`,
 * `PerformerFilterType`).
 *
 * Always returns a plain object, so callers can drop their `filter || {}`.
 * An unrecognised filter type is returned untouched rather than mangled.
 */
export function translateFilter(raw, filterTypeName) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) return {};
  if (!FILTER_TYPES[filterTypeName]) {
    warnOnce(`unknown filter type "${filterTypeName}" — passed through untranslated`);
    return raw;
  }
  return translateObject(raw, filterTypeName);
}
