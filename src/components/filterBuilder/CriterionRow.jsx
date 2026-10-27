import { useFocusable } from '../../hooks/useFocusable.js';
import { EDITOR, NULLARY } from '../../utils/filterCriteria.js';
import { MODIFIER_LABELS, numericOrText, asStoredEnum } from './criterionDraft.js';
import { editorChainIds, editorParts } from './editors/index.js';
import { Choice } from './Choice.jsx';
import { TextValue } from './TextValue.jsx';
import styles from '../FilterBuilder.module.css';

// The row head and remove button, the modifier, and the editor's controls.
// What each editor renders comes from the registry (editors/index.js); the row
// owns the D-pad chain that ties the controls together.
export function CriterionRow({ desc, criterion, onChange, onRemove, onPickEntities }) {
  const { field, label } = desc;

  const modifierOptions = desc.modifierOptions.map(m => ({ value: m, label: MODIFIER_LABELS[m] || m }));

  const setModifier = (m) => {
    // Switching to a nullary modifier drops the operand rather than leaving a
    // stale one beside it, the translator would send it.
    onChange(NULLARY.has(m) ? { modifier: m, value: {} } : { ...criterion, modifier: m });
  };

  const inner = criterion.value && typeof criterion.value === 'object' && !Array.isArray(criterion.value)
    ? criterion.value
    : {};

  const setInner = (patch) => onChange({ ...criterion, value: { ...inner, ...patch } });

  // Both must be `useFocusable`, not plain <button>: spatial nav only searches
  // `registry`, and a DOM `.click()` works either way, so an off-device harness
  // cannot catch the difference. The pick button's focusable lives here to keep
  // registration order; the button comes from the registry's `pick` part.
  //
  // `.rowBody` wraps, and geometry then reads Left as "towards whatever is on
  // screen left", a footer button. Two fixes are both needed: the row gets its
  // own zone (Left/Right do not cross zones without `crossZone`), and it
  // declares its own left-to-right order.
  //
  // The chain must list exactly what was rendered, in DOM order: a missing entry
  // and an entry naming an absent control both fall back to geometry, alike on
  // the TV.
  const rowZone = `fb-row-${field}`;
  const parts = editorParts(field, desc, criterion);
  const chain = [`fb-rm-${field}`];
  if (modifierOptions.length > 0) chain.push(`fb-mod-${field}`);
  chain.push(...editorChainIds(field, desc, criterion));

  // At either end the direction falls through to the geometry, where the row's
  // own zone leaves nothing sideways to find, the line is the unit.
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
    } else if (part.apply === 'value') {
      // is_missing: a bare String at the filter level, stored in the envelope.
      setInner({ value });
    } else {
      // BOOLEAN and TRI keep the chosen value as a string on the criterion
      // itself, beside the modifier, see boolean.js.
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
