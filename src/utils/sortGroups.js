/**
 * sortGroups.js: flatten a tab descriptor's grouped sort options.
 *
 * `sortGroups` is `[{ label, options: [{ value, label }] }]`. App validates a
 * stored sort value against the flat list and ControlsPanel uses it for the
 * value → label lookup; one definition keeps a new group shape from being
 * understood by only one of them.
 */

export function flattenSortGroups(groups) {
  return (groups || []).flatMap(g => g.options);
}
