/**
 * sortGroups.js — flatten a tab descriptor's grouped sort options.
 *
 * `sortGroups` is an array of `{ label, options: [{ value, label }] }`
 * groups. Two places need the flat list: App validates a stored sort value
 * against it, and ControlsPanel uses it for the value → label lookup. They
 * carried identical copies until 0.23.1; one definition keeps a new group
 * shape from being understood by only one of them.
 */

export function flattenSortGroups(groups) {
  return (groups || []).flatMap(g => g.options);
}
