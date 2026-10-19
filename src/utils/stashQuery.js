/**
 * stashQuery.js — `graphqlRequest`, bound to whatever the settings store
 * currently holds.
 *
 * `stashClient.js` is deliberately pure: it takes the endpoint and key as
 * arguments so that `settings.js` can use its `fetchWithTimeout` without
 * creating a `stashClient → settings → stashClient` import cycle. That
 * purity means every caller has to look the settings up itself — and all
 * four service modules ended up with their own byte-identical three-line
 * copy of exactly that lookup.
 *
 * This is that lookup, once. It sits *above* both modules in the
 * dependency graph, which is what keeps the cycle from coming back:
 *
 *     stashClient.js  (no imports)
 *            ↑
 *     settings.js     (imports stashClient)
 *            ↑
 *     stashQuery.js   (imports settings + stashClient)
 *            ↑
 *     videoService / markerService / performerService / filterService
 *
 * The settings are read per call, not captured at import time, so a
 * Test↔Live switch or an endpoint change takes effect on the very next
 * request — including the first one after the settings modal saves.
 */

import { getSettings } from './settings.js';
import { graphqlRequest } from './stashClient.js';

export function runQuery(query, variables) {
  const { stashUrl, stashKey } = getSettings();
  return graphqlRequest(query, variables, { url: stashUrl, key: stashKey });
}
