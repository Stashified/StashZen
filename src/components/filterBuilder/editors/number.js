import { EDITOR } from '../../../utils/filterCriteria.js';
import { innerOf } from './common.js';
import { DEPTH_OPTIONS } from './depth.js';

/**
 * NUMBER, DATE and TIMESTAMP: one value box, plus a second only when the field
 * supports a range and the modifier asks for one. The range box depends on the
 * descriptor and the current modifier, not just the field.
 */
const isRange = (desc, criterion) =>
  Boolean(desc.supportsRange
    && (criterion.modifier === 'BETWEEN' || criterion.modifier === 'NOT_BETWEEN'));

export const chainIds = (field, desc, criterion) => {
  const ids = [`fb-val-${field}`];
  if (isRange(desc, criterion)) ids.push(`fb-val2-${field}`);
  if (desc.hierarchicalCount) ids.push(`fb-depth-${field}`);
  return ids;
};

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  const numeric = desc.editor === EDITOR.NUMBER
    || desc.editor === EDITOR.HIERARCHICAL_COUNT;
  const out = [{
    kind: 'text',
    id: `fb-val-${field}`,
    apply: 'value',
    numeric,
    value: inner.value ?? '',
    placeholder: numeric ? 'Number' : 'YYYY-MM-DD',
  }];
  if (isRange(desc, criterion)) {
    out.push({
      kind: 'text',
      id: `fb-val2-${field}`,
      apply: 'value2',
      numeric,
      value: inner.value2 ?? '',
      placeholder: '…and',
    });
  }
  if (desc.hierarchicalCount) {
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
