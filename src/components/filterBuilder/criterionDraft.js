import { EDITOR, NULLARY, RANGE } from '../../utils/filterCriteria.js';
import { savedEnumValue, requestEnumValue } from '../../utils/enumStrings.js';

// The one place that knows the four stored shapes. Nullary modifiers take no
// operand, so their value is `{}` rather than `''`: the translator supplies the
// minimal well-typed operand the input type requires.
export function blankCriterion(desc) {
  const modifier = desc.modifierOptions[0] || null;

  switch (desc.editor) {
    case EDITOR.BOOLEAN:
    case EDITOR.TRI:
      return { modifier: 'EQUALS', value: 'true' };
    case EDITOR.MULTI:
    case EDITOR.HIERARCHICAL:
      return { modifier: 'INCLUDES', value: { items: [], excluded: [] } };
    case EDITOR.ENUM:
      // One enum field declares a list value, hence `listValued` from the
      // schema rather than a field-name list. Getting this wrong sends a
      // scalar where a list is expected and the server rejects the filter.
      return { modifier, value: { value: desc.listValued ? [] : '' } };
    case EDITOR.IS_MISSING:
      // Bare String at the filter level; no modifier and a closed vocabulary.
      return { modifier: null, value: { value: '' } };
    default:
      return { modifier, value: {} };
  }
}

/** Does this criterion currently carry an operand? */
export function hasOperand(c) {
  return !NULLARY.has(c?.modifier);
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Stash stores a multi entry as `{id, label}`; a request-shaped seed (tag and
// studio activation, Continue Watching) carries bare ids. Wrap those so the row
// can print them and a Save stays in the stored shape.
const labelled = (v) => (isPlainObject(v) ? v : { id: v, label: '' });

/**
 * The builder writes Stash's stored envelope but is seeded from the request
 * side, where tag/studio/gallery activation and Continue Watching hand over
 * the *GraphQL* shape (`{value: [id]}`, `{value: 0}`). `translateFilter`
 * accepts both, but the rows do not: an unconverted filter rendered empty and
 * was dropped on Apply. Convert on the way in.
 *
 * A stored operand is always an object (booleans and nullary included); any
 * other shape came from the request side.
 */
export function seedCriterion(desc, c) {
  if (c == null) return c;
  if (!desc.editor) return c;

  // A bare String field (`is_missing`) arrives as the scalar itself, not an
  // envelope. Wrap it so the row has something to edit.
  const scalar = typeof c !== 'object';
  if (!scalar && isPlainObject(c.value)) return c;

  const src = scalar ? { value: c } : c;
  const modifier = src.modifier
    ?? desc.modifierOptions?.[0]
    ?? null;
  if (NULLARY.has(modifier)) return { modifier, value: {} };

  switch (desc.editor) {
    case EDITOR.BOOLEAN:
    case EDITOR.TRI:
      return { modifier, value: String(src.value ?? 'true') };
    case EDITOR.MULTI:
    case EDITOR.HIERARCHICAL: {
      const value = {
        items: Array.isArray(src.value) ? src.value.map(labelled) : [],
        excluded: Array.isArray(src.excludes) ? src.excludes.map(labelled) : [],
      };
      if (src.depth != null) value.depth = src.depth;
      return { modifier, value };
    }
    case EDITOR.STASH_ID:
    case EDITOR.STASH_IDS:
      return {
        modifier,
        value: {
          endpoint: src.endpoint ?? '',
          ...(desc.editor === EDITOR.STASH_IDS
            ? { stashIDs: src.stash_ids ?? src.stashIDs ?? '' }
            : { stashID: src.stash_id ?? src.stashID ?? '' }),
        },
      };
    case EDITOR.ENUM: {
      // Stash's web UI can store a gender criterion as `value_list` with no
      // scalar `value`. Reading only `value` seeded the row blank, and Apply
      // then dropped the criterion.
      const fromList = Array.isArray(src.value_list) ? src.value_list : [];
      const list = Array.isArray(src.value) && src.value.length ? src.value : fromList;
      const scalar = src.value === '' || src.value == null ? fromList[0] : src.value;
      // Stash's web UI stores display strings ("1080p", "Female"); the picker
      // is keyed by member names.
      return {
        modifier,
        value: {
          value: desc.listValued
            ? list.map(v => requestEnumValue(desc.type, v))
            : requestEnumValue(desc.type, scalar ?? ''),
        },
      };
    }
    case EDITOR.IS_MISSING:
      return { modifier: null, value: { value: typeof src.value === 'string' ? src.value : '' } };
    default:
      return {
        modifier,
        value: {
          value: src.value,
          ...(src.value2 !== undefined ? { value2: src.value2 } : {}),
        },
      };
  }
}

export const MODIFIER_LABELS = {
  EQUALS: 'is', NOT_EQUALS: 'is not',
  INCLUDES: 'includes', EXCLUDES: 'excludes', INCLUDES_ALL: 'includes all',
  GREATER_THAN: 'more than', LESS_THAN: 'less than',
  BETWEEN: 'between', NOT_BETWEEN: 'not between',
  MATCHES_REGEX: 'matches', NOT_MATCHES_REGEX: 'does not match',
  IS_NULL: 'is empty', NOT_NULL: 'is not empty',
};

/** Numbers must survive as numbers; a string "70" is a GraphQL type error. */
export function numericOrText(v, editor) {
  if (editor !== EDITOR.NUMBER) return v;
  if (v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/** FULL_HD → "Full HD". */
export const prettyEnum = (v) => v.split('_').map(w => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(' ');

/** A list-valued enum holds `['CUT']`; the dropdown shows one choice at a time. */
export const choiceOf = (v, listValued) => (listValued ? (Array.isArray(v) ? v[0] : '') : v) ?? '';

/** …and back, so the stored envelope keeps the shape the schema declares. */
export const asStoredEnum = (v, listValued) => (listValued ? (v ? [v] : []) : v);

/**
 * Would this criterion translate to something? Blank criteria are not counted,
 * so they do not inflate the "3 criteria" count.
 */
export function isEffective(desc, c) {
  if (!c) return false;
  const operand = hasOperand(c);
  const inner = c.value && typeof c.value === 'object' && !Array.isArray(c.value) ? c.value : {};
  const items = Array.isArray(inner.items) ? inner.items : [];
  const excluded = Array.isArray(inner.excluded) ? inner.excluded : [];
  const isMulti = [EDITOR.MULTI, EDITOR.HIERARCHICAL].includes(desc.editor);
  const isListValuedEnum = desc.editor === EDITOR.ENUM && desc.listValued;
  // BOOLEAN/TRI keep their operand at `criterion.value`; STASH_ID/STASH_IDS
  // use a named key. Testing only `inner.value` drops all three silently.
  const isBoolean = desc.editor === EDITOR.BOOLEAN || desc.editor === EDITOR.TRI;
  const isStashId = desc.editor === EDITOR.STASH_ID || desc.editor === EDITOR.STASH_IDS;

  // A nullary modifier ("is empty") constrains on its own; the translator
  // supplies the operand the input type requires. Every check below is about
  // an operand, so none of them may drop it. The NUMBER, STASH_ID and
  // list-enum branches used to, which silently widened the filter.
  if (!operand) return true;
  // An exclusion-only multi constrains through `excluded`; counting `items`
  // alone dropped a saved exclude list on the next Apply or Save.
  if (isMulti) return items.length > 0 || excluded.length > 0;
  if (isListValuedEnum) return Array.isArray(inner.value) && inner.value.length > 0;
  if (isBoolean) return c.value === 'true' || c.value === 'false' || typeof c.value === 'boolean';
  if (isStashId) {
    const id = desc.editor === EDITOR.STASH_IDS ? inner.stashIDs : inner.stashID;
    if (!inner.endpoint || id === '' || id === undefined || id === null) return false;
    return true;
  }
  if (inner.value === '' || inner.value === undefined || inner.value === null) return false;
  // An Int criterion with a decimal is a GraphQL type error, and a text box is
  // free to hold one; keep the row visible but out of the request.
  if (desc.editor === EDITOR.NUMBER) {
    const isInt = String(desc.type).replace(/[[\]!]/g, '') === 'IntCriterionInput';
    const bad = (v) => {
      const n = Number(v);
      return !Number.isFinite(n) || (isInt && !Number.isInteger(n));
    };
    if (bad(inner.value)) return false;
    if (RANGE.has(c.modifier) && bad(inner.value2)) return false;
  }
  // A range needs both bounds: one-sided BETWEEN returns an empty result, not
  // an error.
  if (RANGE.has(c.modifier)
    && (inner.value2 === '' || inner.value2 === undefined || inner.value2 === null)) {
    return false;
  }
  return true;
}

/**
 * The criteria that would actually be sent, in the builder's row order.
 * Fields the builder cannot render (AND/OR/NOT, custom fields, fields from a
 * newer schema) pass through verbatim: dropping them would silently widen the
 * filter, and the banner promises they are kept.
 */
export function effectiveCriteria(order, criteria, byField) {
  const out = {};
  for (const field of order) {
    const c = criteria[field];
    if (!c) continue;
    const desc = byField.get(field);
    if (!desc || !desc.editor) { out[field] = c; continue; }
    if (isEffective(desc, c)) out[field] = c;
  }
  return out;
}

/**
 * The builder's internal envelopes → the shape Stash's web UI persists.
 * Only text and enums differ: the UI stores a bare string and display strings,
 * while the rows need a nested value and enum member names. Other criterion
 * types already use Stash's stored shape.
 */
export function storedCriterion(desc, c) {
  const inner = c.value && typeof c.value === 'object' && !Array.isArray(c.value) ? c.value : {};
  switch (desc.editor) {
    case EDITOR.TEXT:
      return { modifier: c.modifier, value: inner.value ?? '' };
    case EDITOR.ENUM:
      return {
        modifier: c.modifier,
        value: desc.listValued
          ? (Array.isArray(inner.value) ? inner.value : []).map(v => savedEnumValue(desc.type, v))
          : savedEnumValue(desc.type, inner.value ?? ''),
      };
    case EDITOR.IS_MISSING:
      return inner.value ?? '';
    case EDITOR.MULTI:
    case EDITOR.HIERARCHICAL:
      // Normalise here too: an entry that never went through the picker would
      // otherwise be written back as a bare id, which is not the stored shape.
      return {
        modifier: c.modifier,
        value: {
          items: (Array.isArray(inner.items) ? inner.items : []).map(labelled),
          excluded: (Array.isArray(inner.excluded) ? inner.excluded : []).map(labelled),
          ...(inner.depth != null ? { depth: inner.depth } : {}),
        },
      };
    default:
      return c;
  }
}

/** `effectiveCriteria` → the stored shape, for `saveFilter`. */
export function storedCriteria(order, criteria, byField) {
  const effective = effectiveCriteria(order, criteria, byField);
  const out = {};
  for (const [field, c] of Object.entries(effective)) {
    const desc = byField.get(field);
    out[field] = desc && desc.editor ? storedCriterion(desc, c) : c;
  }
  return out;
}
