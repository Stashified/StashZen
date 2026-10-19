/**
 * What the editors share. Kept separate from `index.js` so the editor modules
 * can import it without a cycle.
 */

/**
 * The stored envelope's inner object — `{ value, value2, items, depth, … }`.
 * A nullary modifier stores `{}`, and a malformed value is treated as empty
 * rather than crashing the row.
 */
export const innerOf = (criterion) => (
  criterion.value && typeof criterion.value === 'object' && !Array.isArray(criterion.value)
    ? criterion.value
    : {}
);
