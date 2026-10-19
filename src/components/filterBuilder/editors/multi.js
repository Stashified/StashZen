import { innerOf } from './common.js';

/**
 * MULTI and HIERARCHICAL: the entity picker button, plus a depth choice for
 * hierarchical fields.
 *
 * Both controls were plain <button>s once, which on the TV means unreachable:
 * spatial nav searches `registry`, and only `useFocusable` puts anything in
 * it. The pick button's focus comes from `useFocusable` in CriterionRow —
 * kept there rather than here so the row's two focusables register in the
 * same order they always have — and the depth choice is a Choice like any
 * other.
 *
 * `disabled` rather than hidden for a multi-valued field with no entity
 * source: `useFocusable` skips registration when disabled, so the control
 * drops out of the D-pad order instead of being a focus stop that does
 * nothing.
 */
export const chainIds = (field, desc) => {
  const ids = [`fb-pick-${field}`];
  if (desc.hierarchical) ids.push(`fb-depth-${field}`);
  return ids;
};

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  const items = Array.isArray(inner.items) ? inner.items : [];
  const out = [{
    kind: 'pick',
    id: `fb-pick-${field}`,
    entity: Boolean(desc.entity),
    text: items.length
      ? items.map(i => i.label).join(', ')
      : (desc.entity ? 'Choose…' : 'No picker for this field'),
  }];
  if (desc.hierarchical) {
    out.push({
      kind: 'choice',
      id: `fb-depth-${field}`,
      apply: 'depth',
      label: 'Depth',
      value: String(inner.depth ?? 0),
      options: [
        { value: '0', label: 'This only' },
        { value: '1', label: 'Include children' },
        { value: '2', label: 'Two levels' },
      ],
    });
  }
  return out;
};
