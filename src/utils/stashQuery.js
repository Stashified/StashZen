/**
 * stashQuery.js: `graphqlRequest`, bound to whatever the settings store
 * currently holds.
 *
 * `stashClient.js` is pure, so every caller must look the settings up itself.
 * This is that lookup, once, sitting *above* both modules so the import cycle
 * cannot return:
 *
 *     stashClient.js  (no imports)
 *            ↑
 *     settings.js     (imports stashClient)
 *            ↑
 *     stashQuery.js   (imports settings + stashClient)
 *            ↑
 *     videoService / markerService / performerService / filterService
 *
 * Settings are read per call, not captured at import, so a Test↔Live switch or
 * endpoint change takes effect on the next request, including the first after
 * the settings modal saves.
 */

import { getSettings } from './settings.js';
import { graphqlRequest } from './stashClient.js';

export function runQuery(query, variables, { signal } = {}) {
  const { stashUrl, stashKey } = getSettings();
  return graphqlRequest(query, variables, { url: stashUrl, key: stashKey, signal });
}

/**
 * The same list document without its `count` selection.
 *
 * Stash computes `count` over the whole filtered set, the expensive half of a
 * listing request, and only page 1's total is ever read (usePagedList keeps the
 * first and ignores the rest). So paging past the first page asks for the rows
 * alone.
 *
 * This matches the first standalone `count` line: every listing document here
 * puts it directly under its result root. A document that does not match is
 * returned as-is, so a failure to find it only means the count is still
 * fetched, never a malformed query.
 */
export function withoutCount(query) {
  return query.replace(/^[ \t]*count[ \t]*$/m, '');
}
