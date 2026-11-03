/**
 * capabilities.js: which server features this app may use.
 *
 * The app supports Stash 0.31.1 and newer. A GraphQL field or sort a server
 * does not know fails the whole request, not just that field, so anything added
 * after 0.31.1 is gated on the server's reported version.
 *
 * `undefined` is "not known yet" and hides gated UI: a false negative costs a
 * menu entry until the version request lands, a false positive costs a broken
 * listing.
 */

import { compareVersions } from './updateCheck.js';

// feature name → first Stash version that has it.
export const CAPABILITY_MIN_VERSION = {
  // Scene.production_date and the sort of the same name.
  productionDate: '0.32.0',
  // Studio sorts o_counter, performer_count, scene_markers_count.
  studioEngagementSorts: '0.32.0',
  // Gallery/Image sort performer_age.
  performerAgeSort: '0.32.0',
  // TagFilterType count fields take HierarchicalCountInput (a `depth`).
  hierarchicalTagCounts: '0.32.0',
  // Studio.o_counter and scene_marker_count take a recursive `depth`.
  studioRecursiveCounts: '0.32.0',
};

export function supportsCapability(version, name) {
  const min = CAPABILITY_MIN_VERSION[name];
  if (!min || !version) return false;
  // compareVersions returns null for an unreadable version, and `null >= 0`
  // is true in JS, so the null case must be rejected explicitly.
  const order = compareVersions(version, min);
  return order !== null && order >= 0;
}
