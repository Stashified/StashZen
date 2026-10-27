import { innerOf } from './common.js';
import { choiceOf, prettyEnum } from '../criterionDraft.js';

/**
 * ENUM. A list-valued enum (LIST_VALUED_CRITERIA) stores `['CUT']` but the
 * dropdown shows one choice; `choiceOf`/`asStoredEnum` convert, and live in
 * criterionDraft so both sides of the round trip agree.
 */
export const chainIds = (field) => [`fb-val-${field}`];

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  return [{
    kind: 'choice',
    id: `fb-val-${field}`,
    apply: 'enum',
    value: choiceOf(inner.value, desc.listValued),
    options: [
      { value: '', label: '–' },
      ...(desc.enumOptions || []).map(v => ({
        value: v,
        label: desc.enumLabels?.[v] || prettyEnum(v),
      })),
    ],
  }];
};
