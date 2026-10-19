import { EDITOR } from '../../../utils/filterCriteria.js';
import { innerOf } from './common.js';

/**
 * TEXT and PHASH. PHASH is the same single text box with a different
 * placeholder: the hash itself is plain text, and its distance travels in
 * the criterion's other fields (see `criterionDraft`'s phash handling).
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
