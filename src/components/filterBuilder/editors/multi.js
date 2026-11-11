import { innerOf } from './common.js';
import { DEPTH_OPTIONS } from './depth.js';

/**
 * MULTI and HIERARCHICAL: the entity picker button, plus a depth choice for
 * hierarchical fields.
 *
 * The pick button's focusable lives in CriterionRow, so the row's two
 * focusables keep their registration order; the depth choice is a Choice.
 *
 * `disabled` rather than hidden when there is no entity source:
 * `useFocusable` skips registration when disabled, dropping it from the D-pad
 * order instead of leaving a dead stop.
 */
export const chainIds = (field, desc) => {
  const ids = [`fb-pick-${field}`];
  if (desc.hierarchical) ids.push(`fb-depth-${field}`);
  return ids;
};

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  const items = Array.isArray(inner.items) ? inner.items : [];
  const excluded = Array.isArray(inner.excluded) ? inner.excluded : [];
  const print = (list) => list.map(i => i.label || String(i.id)).join(', ');
  const shown = [];
  // An entry can arrive without a label (a request-shaped seed); print the id
  // rather than an empty button. An exclusion-only criterion is still applied,
  // so "Choose…" would describe it as unset.
  if (items.length) shown.push(print(items));
  // A plain multi's save drops exclusions but Apply still sends them; an
  // exclusion-only one is saved empty. Flag the loss and never let the row
  // read as unset.
  if (excluded.length) {
    shown.push(desc.hierarchical
      ? `${excluded.length} excluded`
      : `${excluded.length} excluded (not saved)`);
  }
  const out = [{
    kind: 'pick',
    id: `fb-pick-${field}`,
    entity: Boolean(desc.entity),
    text: shown.length
      ? shown.join(' · ')
      : (desc.entity ? 'Choose…' : 'No picker for this field'),
  }];
  if (desc.hierarchical) {
    out.push({
      kind: 'choice',
      id: `fb-depth-${field}`,
      apply: 'depth',
      label: 'Depth',
      value: String(inner.depth ?? 0),
      options: DEPTH_OPTIONS,
    });
  }
  return out;
};
