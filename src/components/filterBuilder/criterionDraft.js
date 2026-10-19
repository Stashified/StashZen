import { EDITOR, NULLARY } from '../../utils/filterCriteria.js';

// ── Envelope construction ─────────────────────────────────
//
// The one place that knows the four stored shapes. `nullary` modifiers take no
// operand, so their value is an empty object rather than an empty string —
// measured: `{value: {}}` translates to a criterion carrying only its
// modifier, while `{value: {value: ''}}` carries the empty string through to
// the server. Both validate; only one is clean.
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
      // One enum criterion — `circumcised` — declares `value` as a *list*,
      // which is why `listValued` comes off the schema rather than off a list
      // of field names. Getting this wrong sends a scalar where a list is
      // expected and the server rejects the whole filter.
      return { modifier, value: { value: desc.listValued ? [] : '' } };
    default:
      return { modifier, value: {} };
  }
}

/** Does this criterion currently carry an operand? */
export function hasOperand(c) {
  return !NULLARY.has(c?.modifier);
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The builder reads and writes Stash's *stored* envelope, but it is seeded
 * from the request side, where a tag/studio/gallery activation and Continue
 * Watching hand over the *GraphQL* shape (`{value: [id]}`,
 * `{value: 0}`). `translateFilter` treats the two alike on the way out, so
 * the request path never noticed; the rows and `effective` below do not, and
 * an un-converted working filter rendered empty and was then dropped on
 * Apply — the visible filter row said "Choose…" while a filter was patently
 * applied. Convert on the way in.
 *
 * A stored criterion is recognisable without the editor: every stored operand
 * is an object (booleans and nullary criteria included — see
 * `blankCriterion`). Anything else came from the request side.
 */
export function seedCriterion(desc, c) {
  if (!c || typeof c !== 'object') return c;
  if (isPlainObject(c.value)) return c;

  const modifier = c.modifier;
  if (NULLARY.has(modifier)) return { modifier, value: {} };
  if (!desc.editor) return c;

  switch (desc.editor) {
    case EDITOR.BOOLEAN:
    case EDITOR.TRI:
      return { modifier: modifier || 'EQUALS', value: String(c.value ?? 'true') };
    case EDITOR.MULTI:
    case EDITOR.HIERARCHICAL: {
      const value = {
        items: Array.isArray(c.value) ? c.value : [],
        excluded: Array.isArray(c.excludes) ? c.excludes : [],
      };
      if (c.depth != null) value.depth = c.depth;
      return { modifier, value };
    }
    case EDITOR.STASH_ID:
    case EDITOR.STASH_IDS:
      return {
        modifier,
        value: {
          endpoint: c.endpoint ?? '',
          ...(desc.editor === EDITOR.STASH_IDS
            ? { stashIDs: c.stash_ids ?? c.stashIDs ?? '' }
            : { stashID: c.stash_id ?? c.stashID ?? '' }),
        },
      };
    case EDITOR.ENUM:
      return {
        modifier,
        value: { value: desc.listValued ? (Array.isArray(c.value) ? c.value : []) : (c.value ?? '') },
      };
    default:
      return {
        modifier,
        value: { value: c.value, ...(c.value2 !== undefined ? { value2: c.value2 } : {}) },
      };
  }
}

// ── Helpers shared with CriterionRow ──────────────────────
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
 * Would this criterion translate to something? Only fields that would go out
 * are counted, so a criterion left at its blank state — an empty text box —
 * does not inflate the "3 criteria" count.
 */
export function isEffective(desc, c) {
  if (!c) return false;
  const operand = hasOperand(c);
  const inner = c.value && typeof c.value === 'object' && !Array.isArray(c.value) ? c.value : {};
  const items = Array.isArray(inner.items) ? inner.items : [];
  const isMulti = [EDITOR.MULTI, EDITOR.HIERARCHICAL].includes(desc.editor);
  const isListValuedEnum = desc.editor === EDITOR.ENUM && desc.listValued;
  // BOOLEAN/TRI keep their operand at `criterion.value` as a string (the
  // stored shape), and STASH_ID/STASH_IDS put theirs under a named key.
  // Testing only `inner.value` dropped all three from every filter — an
  // "Organized — Yes" criterion could be added, counted as 0, and never
  // leave the builder.
  const isBoolean = desc.editor === EDITOR.BOOLEAN || desc.editor === EDITOR.TRI;
  const isStashId = desc.editor === EDITOR.STASH_ID || desc.editor === EDITOR.STASH_IDS;

  if (isMulti) return items.length > 0;
  if (isListValuedEnum) return Array.isArray(inner.value) && inner.value.length > 0;
  if (isBoolean) return c.value === 'true' || c.value === 'false' || typeof c.value === 'boolean';
  if (isStashId) {
    const id = desc.editor === EDITOR.STASH_IDS ? inner.stashIDs : inner.stashID;
    if (!inner.endpoint || id === '' || id === undefined || id === null) return false;
    return true;
  }
  if (operand && (inner.value === '' || inner.value === undefined || inner.value === null)) return false;
  return true;
}

/** The criteria that would actually be sent, in the builder's row order. */
export function effectiveCriteria(order, criteria, byField) {
  const out = {};
  for (const field of order) {
    const c = criteria[field];
    if (!c || !byField.has(field)) continue;
    if (isEffective(byField.get(field), c)) out[field] = c;
  }
  return out;
}
