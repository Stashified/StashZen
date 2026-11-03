/**
 * filterSchema.js: the generated 0.31 snapshot plus the 0.32 delta.
 *
 * The snapshot is deliberately pinned: regenerating it against 0.32 would make
 * a 0.31 server reject every request that mentions a newer field. Instead the
 * baseline stays 0.31 and this module merges only the additions the server
 * reports it supports.
 *
 * Null or unknown versions get the baseline unchanged.
 */

import * as base from './stashFilterSchema.js';
import { supportsCapability } from './capabilities.js';

// Fields Stash 0.32 re-typed from IntCriterionInput to HierarchicalCountInput.
// Missing names are skipped, so this list can outlive a schema change.
const TAG_COUNT_FIELDS = [
  'scene_count', 'image_count', 'gallery_count', 'performer_count',
  'studio_count', 'group_count', 'marker_count', 'movie_count',
];

const HIERARCHICAL_COUNT_FIELDS = ['modifier', 'value', 'value2', 'depth'];

// Fields this module adds on top of the baseline, by filter type, with the
// capability that unlocks them. The translator needs this to tell "a field we
// do not know" (forward it) from "a field we know this server cannot take"
// (drop it: forwarding fails the whole query).
const GATED_FIELDS = {
  SceneFilterType: { production_date: 'productionDate' },
};

const cache = new Map();

/** The capability a delta field needs, or null when the field is baseline. */
export function fieldCapability(filterTypeName, field) {
  return GATED_FIELDS[filterTypeName]?.[field] || null;
}

function build(version) {
  const filterTypes = { ...base.FILTER_TYPES };
  const criterionFields = { ...base.CRITERION_FIELDS };

  if (supportsCapability(version, 'productionDate')) {
    filterTypes.SceneFilterType = {
      ...filterTypes.SceneFilterType,
      production_date: 'DateCriterionInput',
    };
  }

  if (supportsCapability(version, 'hierarchicalTagCounts')) {
    const tag = { ...filterTypes.TagFilterType };
    for (const field of TAG_COUNT_FIELDS) {
      if (field in tag) tag[field] = 'HierarchicalCountInput';
    }
    filterTypes.TagFilterType = tag;
    criterionFields.HierarchicalCountInput = HIERARCHICAL_COUNT_FIELDS;
  }

  return {
    ...base,
    FILTER_TYPES: filterTypes,
    CRITERION_FIELDS: criterionFields,
  };
}

/** The schema a given server version can accept. Cached per version string. */
export function schemaFor(version) {
  const key = version || '';
  if (!cache.has(key)) cache.set(key, build(version));
  return cache.get(key);
}
