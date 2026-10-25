import { EDITOR } from '../../../utils/filterCriteria.js';
import { innerOf } from './common.js';

/**
 * STASH_ID and STASH_IDS: endpoint and id side by side. They differ only in
 * the id's key (`stashID` / `stashIDs`), which the translator renames, so keep
 * those keys as they are. Seeding accepts either spelling, so the box reads
 * whichever is present.
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
