/**
 * sortGroups.js: flatten a tab descriptor's grouped sort options.
 *
 * `sortGroups` is `[{ label, options: [{ value, label }] }]`. App validates a
 * stored sort value against the flat list and ControlsPanel uses it for the
 * value → label lookup; one definition keeps a new group shape from being
 * understood by only one of them.
 */

import { supportsCapability } from './capabilities.js';

export function flattenSortGroups(groups) {
  return (groups || []).flatMap(g => g.options);
}

/**
 * The groups a server version can honour. An option names its capability; a
 * group that loses every option disappears rather than leaving a header with
 * nothing under it.
 */
export function visibleSortGroups(groups, version) {
  return (groups || [])
    .map(group => ({
      ...group,
      options: group.options.filter(
        option => !option.capability || supportsCapability(version, option.capability),
      ),
    }))
    .filter(group => group.options.length > 0);
}
