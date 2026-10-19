/**
 * pageRequestKey — the request-identity string `usePagedList` resets on.
 *
 * A listing resets to page 1 when its request changes: sort, order, filter,
 * search. `usePagedList` used to take those as a `deps` array and spread it
 * into an effect, which forced an `eslint-disable` on
 * `react-hooks/exhaustive-deps` and silenced the rule for the whole effect.
 * A single derived string restores the lint rule and makes the contract
 * explicit: change the string, reset the list.
 *
 * JSON array encoding is structural — values are quoted and escaped, so no
 * value can forge a part boundary the way a separator-joined string could.
 * Object key order participates, which matches how `useActiveFilter` memoizes
 * the filter (`JSON.stringify`), so identical filter content produces the
 * same key and a genuinely different filter produces a different one.
 *
 * Callers pass plain values (strings, booleans, filter objects or null). Do
 * not pass `fetchPage` or the page size: paging is the hook's business, not
 * part of the request identity.
 */
export function pageRequestKey(...parts) {
  return JSON.stringify(parts);
}
