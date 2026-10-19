import { EDITOR } from '../../../utils/filterCriteria.js';
import { innerOf } from './common.js';

/**
 * STASH_ID and STASH_IDS: the endpoint and the id itself, side by side. The
 * two differ only in which key the id is stored under — `stashID` for the
 * singular criterion, `stashIDs` for the plural one — which is also the key
 * the translator renames, so keep them where they are.
 *
 * Seeding may still leave either spelling in place (`seedCriterion` accepts
 * both), so the id box reads whichever is present.
 */
export const chainIds = (field) => [`fb-ep-${field}`, `fb-sid-${field}`];

export const parts = (field, desc, criterion) => {
  const inner = innerOf(criterion);
  return [
    {
      kind: 'text',
      id: `fb-ep-${field}`,
      apply: 'endpoint',
      value: inner.endpoint ?? '',
      placeholder: 'Endpoint',
    },
    {
      kind: 'text',
      id: `fb-sid-${field}`,
      apply: desc.editor === EDITOR.STASH_IDS ? 'stashIDs' : 'stashID',
      value: inner.stashID ?? inner.stashIDs ?? '',
      placeholder: 'Stash ID',
    },
  ];
};
