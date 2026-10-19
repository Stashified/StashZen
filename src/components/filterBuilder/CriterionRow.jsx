import { useFocusable } from '../../hooks/useFocusable.js';
import { EDITOR, NULLARY } from '../../utils/filterCriteria.js';
import { MODIFIER_LABELS, numericOrText, asStoredEnum } from './criterionDraft.js';
import { editorChainIds, editorParts } from './editors/index.js';
import { Choice } from './Choice.jsx';
import { TextValue } from './TextValue.jsx';
import styles from '../FilterBuilder.module.css';

// ── One criterion row ─────────────────────────────────────
//
// The row head and remove button, the modifier, and the editor's controls.
// What each editor renders is described by the registry (see editors/index.js)
// and drawn by `renderPart` below; the row owns the D-pad chain that ties the
// controls together.
export function CriterionRow({ desc, criterion, onChange, onRemove, onPickEntities }) {
  const { field, label } = desc;

  const modifierOptions = desc.modifierOptions.map(m => ({ value: m, label: MODIFIER_LABELS[m] || m }));

  const setModifier = (m) => {
    // Switching to a nullary modifier drops the operand rather than leaving a
    // stale one beside it — the translator would send it.
    onChange(NULLARY.has(m) ? { modifier: m, value: {} } : { ...criterion, modifier: m });
  };

  const inner = criterion.value && typeof criterion.value === 'object' && !Array.isArray(criterion.value)
    ? criterion.value
    : {};

  const setInner = (patch) => onChange({ ...criterion, value: { ...inner, ...patch } });

  // Both of these were plain <button>s, which on the TV means they could not be
  // reached at all: spatial nav searches `registry`, and only `useFocusable`
  // puts anything in it. A DOM `.click()` — what an off-device driver does —
  // works either way, so the harness cannot see the difference; the check that
  // can is an assertion on the registry itself (see filter-entry F10). Found
  // by reading, 2026-10-16, and it had shipped: the entity picker was
  // unreachable from the remote, which is most of what P2 added.
  //
  // The pick button's focusable stays here, next to the remove button's, so
  // the two register in the order they always have; the button itself is
  // rendered from a `pick` part by the editor registry.
  // ── Keeping Left/Right on this line ──────────────────────
  //
  // `.rowBody` is `flex-wrap: wrap`, so a row with more controls than fit
  // stacks them onto a second line — and then the geometry reads Left from a
  // wrapped control as "towards whatever is to the left *on the screen*",
  // which is a footer button. Reported from the TV, 2026-10-17: from "This
  // only", Left went to Cancel before it would reach "Choose…" on the same
  // line.
  //
  // Two things fix it, and both are needed. The row gets a zone of its own,
  // which shuts the horizontal edges to the footer outright (Left/Right never
  // cross zones without `crossZone`). And the row declares its own order,
  // left to right in the order it renders, because inside a wrapped row the
  // geometry is still free to prefer something on the other visual line.
  //
  // The chain has to list exactly what was rendered, in DOM order — a missing
  // entry is merely a direction that falls back to the geometry, but an entry
  // naming a control that is not there (the entity picker on a field with no
  // entity source, a second value on a range that is not BETWEEN) is the same
  // fallback, so the two mistakes look alike on the TV. The editor's ids come
  // from the registry, where `chainIds` sits in the same module as the
  // `parts` it describes.
  const rowZone = `fb-row-${field}`;
  const parts = editorParts(field, desc, criterion);
  const chain = [`fb-rm-${field}`];
  if (modifierOptions.length > 0) chain.push(`fb-mod-${field}`);
  chain.push(...editorChainIds(field, desc, criterion));

  // At either end of the chain the direction falls through to the geometry,
  // where the row's own zone leaves it with nothing sideways to find. That is
  // the intended answer: the line is the unit, so focus stays on it.
  const edgesOf = (id) => {
    const i = chain.indexOf(id);
    if (i < 0) return null;
    return {
      left: i > 0 ? chain[i - 1] : null,
      right: i < chain.length - 1 ? chain[i + 1] : null,
    };
  };

  const { ref: removeRef, focused: removeFocused } = useFocusable({
    id: `fb-rm-${field}`,
    zone: rowZone,
    nextId: edgesOf(`fb-rm-${field}`),
    onEnter: onRemove,
  });
  const { ref: pickRef, focused: pickFocused } = useFocusable({
    id: `fb-pick-${field}`,
    zone: rowZone,
    nextId: edgesOf(`fb-pick-${field}`),
    onEnter: onPickEntities,
    disabled: !desc.entity,
  });

  // What an editor's control does with a new value. The `apply` name comes
  // from the part, so the dispatcher below stays one switch for every editor.
  const applyText = (part, raw) => {
    const v = part.numeric ? numericOrText(raw, EDITOR.NUMBER) : raw;
    switch (part.apply) {
      case 'value2': setInner({ value2: v }); break;
      case 'endpoint': setInner({ endpoint: raw }); break;
      case 'stashID': setInner({ stashID: raw }); break;
      case 'stashIDs': setInner({ stashIDs: raw }); break;
      default: setInner({ value: v });
    }
  };

  const applyChoice = (part, value) => {
    if (part.apply === 'enum') {
      setInner({ value: asStoredEnum(value, desc.listValued) });
    } else if (part.apply === 'depth') {
      setInner({ depth: Number(value) });
    } else {
      // BOOLEAN and TRI keep the chosen value as a string on the criterion
      // itself, beside the modifier — see boolean.js.
      onChange({ ...criterion, value });
    }
  };

  const renderPart = (part) => {
    switch (part.kind) {
      case 'text':
        return (
          <TextValue
            key={part.id}
            id={part.id}
            zone={rowZone}
            nextId={edgesOf(part.id)}
            value={part.value}
            numeric={part.numeric}
            placeholder={part.placeholder}
            onChange={(v) => applyText(part, v)}
          />
        );

      case 'choice':
        return (
          <Choice
            key={part.id}
            id={part.id}
            zone={rowZone}
            nextId={edgesOf(part.id)}
            label={part.label}
            value={part.value}
            options={part.options}
            onChange={(v) => applyChoice(part, v)}
          />
        );

      case 'pick':
        return (
          <button
            key={part.id}
            ref={pickRef}
            type="button"
            className={`${styles.multiBtn} ${pickFocused ? styles.focused : ''}`}
            onClick={onPickEntities}
            disabled={!part.entity}
          >
            {part.text}
          </button>
        );

      default:
        return null;
    }
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.rowLabel}>{label}</span>
        <button
          ref={removeRef}
          type="button"
          className={`${styles.rowRemove} ${removeFocused ? styles.focused : ''}`}
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          ✕
        </button>
      </div>

      <div className={styles.rowBody}>
        {modifierOptions.length > 0 && (
          <Choice
            id={`fb-mod-${field}`}
            zone={rowZone}
            nextId={edgesOf(`fb-mod-${field}`)}
            value={criterion.modifier}
            options={modifierOptions}
            onChange={setModifier}
          />
        )}

        {parts.map(renderPart)}
      </div>
    </div>
  );
}
