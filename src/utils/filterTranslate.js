/**
 * filterTranslate.js: Stash's *saved-filter* format → the GraphQL input shape.
 *
 * `findSavedFilters` returns `object_filter` in the shape Stash's frontend
 * stores, which the GraphQL API does not accept. Forwarded verbatim, most saved
 * filters fail with an opaque 422, or validate and return nothing, and either
 * way the user sees an empty grid.
 *
 * There is one modifier enum (`CriterionModifier`), so modifiers pass through
 * 1:1; only the *envelopes* differ. Four translations cover the real data:
 *
 *   {modifier, value:{value:N}}                → {value:N, modifier}          Int / Float / timestamp / date
 *   {modifier, value:{items:[{id,label}],      → {value:["id"], modifier,     tags, performers
 *                    excluded:[], depth}}         excludes:["id"], depth}
 *   {modifier, value:{distance, value}}        → {value, modifier, distance}  phash_distance
 *   {modifier, value:{endpoint, stashID}}      → {endpoint, stash_id, modifier}
 *
 * plus a Boolean field (`organized`) stored as the *string* `"false"` in the
 * same envelope, which must be unwrapped and coerced or GraphQL rejects it.
 *
 * THE QUOTING TRAP. Stash's UI wraps a value containing a space in literal
 * double quotes, so many `path` criteria read `"\"/media/library/…/Some Folder\""`.
 * Sent as-is they *validate* and match zero rows, the worst failure mode here,
 * because nothing errors (measured: 0 scenes quoted, a full page de-quoted).
 *
 * DISPATCH IS SCHEMA-DRIVEN, NEVER A FIELD LIST. The generated
 * `stashFilterSchema.js` decides each field's type: `organized`, `interactive`
 * and `performer_favorite` are `Boolean`, while `has_markers`/`is_missing` are
 * `String` and must not be coerced. It also decides whether a multi-select
 * takes `depth` (`HierarchicalMultiCriterionInput` only).
 *
 * UNKNOWN INPUT PASSES THROUGH. Dropping an unrecognised field or shape would
 * silently discard a filter condition, the exact bug this file fixes. A
 * criterion from a newer Stash therefore degrades to today's behaviour rather
 * than quietly widening the filter.
 *
 * IDEMPOTENT. In-code filters (`PerformerDetailPage` passes
 * `{performers: {value:[id], modifier:'INCLUDES'}}`) survive unchanged, so the
 * services can translate unconditionally at query time.
 *
 * WHERE IT IS CALLED. In the three service loaders, just before the request
 * variables, not in `filterService`, so the raw object stays in the
 * `listCache` keys and cache identity is unchanged.
 */

import {
  FILTER_TYPES,
  FILTER_TYPE_NAMES,
  CRITERION_FIELDS,
  CRITERIA_WITHOUT_MODIFIER,
  LIST_VALUED_CRITERIA,
  ENUMS,
} from './stashFilterSchema.js';
import { requestEnumValue } from './enumStrings.js';

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
 * Stash's UI quotes a value that contains a space. Remove exactly one
 * surrounding pair; there is no escaping to undo, because the UI adds one pair
 * and never re-quotes. Exported for the verify script and tests.
 */
export function stripWrappingQuotes(s) {
  if (typeof s !== 'string' || s.length < 2) return s;
  if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  return s;
}

// `IS_NULL` / `NOT_NULL` take no operand, so an empty value beside them is
// normal; every other modifier needs one.
const NULLARY_MODIFIERS = new Set(['IS_NULL', 'NOT_NULL']);

// The input types still declare a non-null operand and Stash rejects the
// nullary criterion without one. The modifier ignores the value, so the
// smallest well-typed operand will do; enums take their first member.
const NULLARY_VALUE = {
  StringCriterionInput: '',
  DateCriterionInput: '',
  TimestampCriterionInput: '',
  IntCriterionInput: 0,
  FloatCriterionInput: 0,
  ResolutionCriterionInput: ENUMS.ResolutionEnum?.[0],
  GenderCriterionInput: ENUMS.GenderEnum?.[0],
  CircumcisionCriterionInput: ENUMS.CircumcisedEnum?.[0]
    ? [ENUMS.CircumcisedEnum[0]]
    : undefined,
};
// Stash-id criteria put the operand in named fields instead of `value`.
const NULLARY_EXTRA = {
  StashIDCriterionInput: { endpoint: '' },
  StashIDsCriterionInput: { endpoint: '' },
};

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
  // Stash's UI saves display strings ("1080p"); GraphQL wants member names.
  // requestEnumValue is a no-op for non-enum types.
  const map = (x) => requestEnumValue(
    typeName,
    typeof x === 'string' ? stripWrappingQuotes(x) : x,
  );
  // Orientation and circumcision declare `value` as a list, so a bare enum is
  // wrapped. A value already in list form goes through `toIds`, which also
  // unwraps `{id,label}` entries.
  if (LIST_VALUED_CRITERIA.has(typeName)) {
    if (Array.isArray(v)) return toIds(v).map(map);
    return [map(v)];
  }
  return map(v);
}

/**
 * Gender is the one criterion that declares both `value` (nullable scalar) and
 * `value_list` (list). Stash's UI writes the list; a stored array sent as
 * `value` is a GraphQL type error that fails the whole query, and display
 * strings ("Female") must become member names.
 */
function translateGender(c) {
  const raw = Array.isArray(c.value)
    ? c.value
    : Array.isArray(c.value_list)
      ? c.value_list
      : isPlainObject(c.value)
        ? (Array.isArray(c.value.value_list) ? c.value.value_list
          : Array.isArray(c.value.value) ? c.value.value
            : c.value.value != null ? [c.value.value] : [])
        : c.value != null ? [c.value] : [];
  const list = raw
    .map(v => requestEnumValue('GenderCriterionInput', typeof v === 'string' ? stripWrappingQuotes(v) : v))
    .filter(v => v != null && v !== '');

  const out = {};
  if (c.modifier != null) out.modifier = c.modifier;
  if (NULLARY_MODIFIERS.has(out.modifier)) {
    out.value = NULLARY_VALUE.GenderCriterionInput;
    return out;
  }
  if (!list.length) return undefined;
  out.value_list = list;
  return out;
}

/**
 * A `Boolean` field, stored as `{modifier:'EQUALS', value:'false'}`, a
 * *string*, which GraphQL rejects here. Returns `undefined` for a value it
 * cannot interpret, which the caller treats as "drop the field".
 */
function coerceBoolean(v) {
  const raw = isPlainObject(v) ? v.value : v;
  if (raw === true || raw === false) return raw;
  if (raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === 'false' || raw === 0 || raw === '0') return false;
  return undefined;
}

/**
 * A bare `String` field (`has_markers`, `is_missing`). These arrive in a
 * criterion envelope but the GraphQL field has no modifier slot, so it is
 * dropped, safe, because Stash encodes the choice in the value ("true" /
 * "false") and treats the modifier as redundant.
 */
function coerceString(v) {
  let raw = isPlainObject(v) ? v.value : v;
  // The builder's text editor nests twice ({value:{value}}); the field itself
  // has no criterion envelope.
  if (isPlainObject(raw)) raw = raw.value;
  return typeof raw === 'string' ? stripWrappingQuotes(raw) : raw;
}

/**
 * Translate one criterion envelope. `undefined` means it constrains nothing
 * (see the empty-value note below).
 */
function translateCriterion(c, typeName) {
  if (!isPlainObject(c)) return c;
  if (typeName === 'GenderCriterionInput') return translateGender(c);

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
      // A blank second bound is not a bound, `value2:""` is a type error.
      if (v.value2 !== undefined && v.value2 !== '' && v.value2 !== null) {
        out.value2 = coerceScalar(typeName, v.value2);
      }
    }
    // Already flat (DuplicationCriterionInput is stored in GraphQL shape) or a
    // shape from a newer Stash we don't model, forward it.
    else {
      Object.assign(out, v);
    }
  } else if (v !== undefined) {
    out.value = coerceScalar(typeName, v);
  }

  // `null` is the builder's "no modifiers here" marker, not an enum value.
  if (modifier != null && !CRITERIA_WITHOUT_MODIFIER.has(typeName)) {
    out.modifier = modifier;
  }

  // Carry across declared keys already at the criterion's top level, the
  // fixed-point half. GraphQL hoists `depth`, `distance` and `endpoint` out of
  // `value`, so an already-translated criterion has them outside, where the
  // shape analysis above never looks; without this a second pass silently
  // drops them. The `out[k] === undefined` guard avoids overriding fresh values.
  const declared = CRITERION_FIELDS[typeName];
  if (declared) {
    for (const key of declared) {
      if (key !== 'value' && key !== 'value2' && key !== 'modifier'
        && c[key] !== undefined && out[key] === undefined) {
        out[key] = c[key];
      }
    }
  }

  // Fill the operand IS_NULL/NOT_NULL ignores but the input type requires.
  // Only when absent: a stored stash-id criterion keeps its endpoint.
  if (NULLARY_MODIFIERS.has(out.modifier)) {
    const extra = NULLARY_EXTRA[typeName];
    if (extra) {
      for (const key of Object.keys(extra)) {
        if (out[key] === undefined) out[key] = extra[key];
      }
    } else if (out.value === undefined && NULLARY_VALUE[typeName] !== undefined) {
      out.value = NULLARY_VALUE[typeName];
    }
  }

  // Prune what the target type doesn't declare: a stray `depth` (only
  // Hierarchical variants accept it) would otherwise turn the query into a 422.
  // Derived from the live schema, not a guess.
  if (declared) {
    for (const key of Object.keys(out)) {
      if (!declared.includes(key)) {
        warnOnce(`${typeName} has no field "${key}"; dropped (value came from a newer or unknown envelope)`);
        delete out[key];
      }
    }
  }

  // Drop a criterion that constrains nothing: `INCLUDES ""` matches every row
  // (silently widening), `EXCLUDES ""` matches none (silently emptying), and
  // neither is what an unset value means. An empty value is only "nothing" when
  // there are no exclusions either, `items: []` beside a non-empty `excluded`
  // does constrain, and dropping it showed rows the user had excluded.
  const emptyValue = out.value === ''
    || (Array.isArray(out.value) && out.value.length === 0);
  const hasExcludes = Array.isArray(out.excludes) && out.excludes.length > 0;
  if (!NULLARY_MODIFIERS.has(out.modifier) && emptyValue && !hasExcludes) return undefined;

  return out;
}

// ── filter objects ────────────────────────────────────────

/** Translate one field. `undefined` means the field should be omitted. */
function translateField(value, fieldType) {
  if (value == null) return undefined;

  // A nested filter (AND / OR / NOT, or `*_filter`). Recent Stash accepts a
  // list of sub-filters here as well as a single object.
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

  // A list of input objects (custom_fields). The stored shape is close enough
  // that guessing a rewrite would be worse than forwarding it.
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
      warnOnce(`${typeName}.${key} is not in the schema snapshot; passed through untranslated`);
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
 * Always a plain object, so callers can drop `filter || {}`. An unrecognised
 * filter type is returned untouched rather than mangled.
 */
export function translateFilter(raw, filterTypeName) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) return {};
  if (!FILTER_TYPES[filterTypeName]) {
    warnOnce(`unknown filter type "${filterTypeName}"; passed through untranslated`);
    return raw;
  }
  return translateObject(raw, filterTypeName);
}
