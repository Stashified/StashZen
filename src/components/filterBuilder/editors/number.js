import { EDITOR } from '../../../utils/filterCriteria.js';
import { innerOf } from './common.js';

/**
 * NUMBER, DATE and TIMESTAMP: one value box, plus a second one only when the
 * field supports a range and the modifier actually asks for one. The second
 * box is the entry that used to go missing from the chain most easily — it
 * depends on both the descriptor and the current modifier, not on the field.
 */
const isRange = (desc, criterion) =>
  Boolean(desc.supportsRange
    && (criterion.modifier === 'BETWEEN' || criterion.modifier === 'NOT_BETWEEN'));

export const chainIds = (field, desc, criterion) => {
  const ids = [`fb-val-${field}`];
  if (isRange(desc, criterion)) ids.push(`fb-val2-${field}`);
  return ids;
};

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  const numeric = desc.editor === EDITOR.NUMBER;
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
  return out;
};
