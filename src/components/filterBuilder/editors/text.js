import { EDITOR } from '../../../utils/filterCriteria.js';
import { innerOf } from './common.js';

/**
 * TEXT and PHASH, one text box each. PHASH is plain text too; its distance
 * travels in the criterion's other fields (see criterionDraft).
 */
export const chainIds = (field) => [`fb-val-${field}`];

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  return [{
    kind: 'text',
    id: `fb-val-${field}`,
    apply: 'value',
    value: inner.value ?? '',
    placeholder: desc.editor === EDITOR.PHASH ? 'Hash' : 'Value',
  }];
};
