import { innerOf } from './common.js';
import { choiceOf, prettyEnum } from '../criterionDraft.js';

/**
 * ENUM. A list-valued enum (LIST_VALUED_CRITERIA) stores `['CUT']` but the
 * dropdown shows one choice at a time; `choiceOf` and `asStoredEnum` are the
 * pair that converts between the two, and they live in criterionDraft so the
 * other side of the round trip agrees with them.
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
      { value: '', label: '—' },
      ...(desc.enumOptions || []).map(v => ({ value: v, label: prettyEnum(v) })),
    ],
  }];
};
