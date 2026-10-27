/**
 * pageRequestKey, the request-identity string `usePagedList` resets on.
 *
 * A listing resets to page 1 when sort, order, filter or search changes. A
 * single derived string beats a `deps` array spread into an effect (which
 * forced an `eslint-disable` on `react-hooks/exhaustive-deps` for the whole
 * effect): change the string, reset the list.
 *
 * JSON array encoding is structural, values are quoted and escaped, so no
 * value can forge a part boundary as a separator-joined string could. Object
 * key order participates, matching how `useActiveFilter` memoizes the filter
 * with `JSON.stringify`.
 *
 * Callers pass plain values (strings, booleans, filter objects or null). Not
 * `fetchPage` or page size: paging is the hook's business.
 */
export function pageRequestKey(...parts) {
  return JSON.stringify(parts);
}
