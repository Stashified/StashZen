/**
 * Depth choices shared by hierarchical multi-selects and hierarchical counts.
 * Stash's own UI stores -1 for "include every descendant", so a saved filter can
 * arrive with it; without the option it printed as "-1" and the first press
 * narrowed it.
 */
export const DEPTH_OPTIONS = [
  { value: '-1', label: 'Any depth' },
  { value: '0', label: 'This only' },
  { value: '1', label: 'Include children' },
  { value: '2', label: 'Two levels' },
];
