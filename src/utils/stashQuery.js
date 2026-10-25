/**
 * stashQuery.js — `graphqlRequest`, bound to whatever the settings store
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
 * endpoint change takes effect on the next request — including the first after
 * the settings modal saves.
 */

import { getSettings } from './settings.js';
import { graphqlRequest } from './stashClient.js';

export function runQuery(query, variables) {
  const { stashUrl, stashKey } = getSettings();
  return graphqlRequest(query, variables, { url: stashUrl, key: stashKey });
}
