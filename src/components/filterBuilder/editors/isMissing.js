import { innerOf } from './common.js';

/**
 * IS_MISSING: Stash's own vocabulary for the filter type. The field takes no
 * modifier and an unknown name matches nothing, so the list is closed.
 */
export const chainIds = (field) => [`fb-val-${field}`];

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  return [{
    kind: 'choice',
    id: `fb-val-${field}`,
    apply: 'value',
    value: inner.value ?? '',
    options: [
      { value: '', label: '–' },
      ...(desc.vocabulary || []).map(v => ({
        value: v,
        label: desc.vocabularyLabels?.[v] || v,
      })),
    ],
  }];
};
