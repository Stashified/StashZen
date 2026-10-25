import { EDITOR } from '../../../utils/filterCriteria.js';
import { hasOperand } from '../criterionDraft.js';
import * as text from './text.js';
import * as number from './number.js';
import * as enumEditor from './enum.js';
import * as boolean from './boolean.js';
import * as multi from './multi.js';
import * as stashId from './stashId.js';

/**
 * The criterion editor registry.
 *
 * Each editor exports two descriptions of the same controls, side by side:
 * `chainIds` (D-pad order, DOM order) and `parts` (what CriterionRow renders).
 * They are independent because `.rowBody` wraps, so wrapped controls fall back
 * to screen geometry — a footer button. A wrong chain and a missing entry look
 * alike there, and only a remote shows either; `scripts/test-filter-chain.mjs`
 * compares them and the harness's F10 checks press the keys.
 *
 * Keep a new editor's `chainIds` beside its `parts`, and add the module here.
 */
export const EDITORS = {
  [EDITOR.TEXT]: text,
  [EDITOR.PHASH]: text,
  [EDITOR.NUMBER]: number,
  [EDITOR.DATE]: number,
  [EDITOR.TIMESTAMP]: number,
  [EDITOR.ENUM]: enumEditor,
  [EDITOR.BOOLEAN]: boolean,
  [EDITOR.TRI]: boolean,
  [EDITOR.MULTI]: multi,
  [EDITOR.HIERARCHICAL]: multi,
  [EDITOR.STASH_ID]: stashId,
  [EDITOR.STASH_IDS]: stashId,
};

export const editorFor = (editor) => EDITORS[editor] || null;

/** Every control kind CriterionRow knows how to render. */
export const PART_KINDS = ['text', 'choice', 'pick'];

// BOOLEAN and TRI have no operand to gate on, but still render their Choice.
const ALWAYS_SHOWN = new Set([EDITOR.BOOLEAN, EDITOR.TRI]);

/** Whether a criterion shows its editor's controls at all. */
const shown = (desc, criterion) => ALWAYS_SHOWN.has(desc.editor) || hasOperand(criterion);

/** The chain for the editor's own controls; the row adds remove/modifier. */
export const editorChainIds = (field, desc, criterion) => {
  const mod = editorFor(desc.editor);
  return mod && shown(desc, criterion) ? mod.chainIds(field, desc, criterion) : [];
};

/** The controls themselves, in DOM order. */
export const editorParts = (field, desc, criterion) => {
  const mod = editorFor(desc.editor);
  return mod && shown(desc, criterion) ? mod.parts(field, desc, criterion) : [];
};
