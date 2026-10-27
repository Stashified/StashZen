/**
 * FilterBuilder, compose a filter in the app instead of in Stash's web UI.
 *
 * Writes Stash's *stored* envelope (what `saveFilter` persists), not the
 * GraphQL shape: GraphQL shape here would produce a filter Stash's own web UI
 * could not open. `criterionDraft.js` is the only builder of these.
 *
 * Fields, editors and legal modifiers all come from `filterCriteria.js`; see
 * the note there on why nothing in this path enumerates fields.
 *
 * FieldPicker and EntityPicker render as DOM children, never through a
 * portal: `focusScopeOf` returns the nearest enclosing `role="dialog"`, and a
 * portalled child would escape to <body>.
 */

import { useMemo, useState } from 'react';
import { useFocusable, registry } from '../hooks/useFocusable.js';
import { criteriaFor } from '../utils/filterCriteria.js';
import EntityPicker from './EntityPicker.jsx';
import styles from './FilterBuilder.module.css';
import {
  blankCriterion, seedCriterion, effectiveCriteria, storedCriteria,
} from './filterBuilder/criterionDraft.js';
import { CriterionRow } from './filterBuilder/CriterionRow.jsx';
import { FieldPicker } from './filterBuilder/FieldPicker.jsx';
import { NamePrompt } from './filterBuilder/NamePrompt.jsx';
import { useBuilderBack } from './filterBuilder/useBuilderBack.js';

export default function FilterBuilder({
  filterType,
  title = 'Filter',
  initial = null,
  initialName = '',
  onApply,
  onSave,
  onClose,
}) {
  const descs = useMemo(() => criteriaFor(filterType), [filterType]);
  const byField = useMemo(() => new Map(descs.map(d => [d.field, d])), [descs]);

  // Ordered, so a row does not jump when its value changes. Seeded through
  // `seedCriterion` because `initial` may still be in GraphQL shape.
  const [order, setOrder] = useState(() => Object.keys(initial || {}));
  const [criteria, setCriteria] = useState(() => {
    const seeded = {};
    for (const [field, c] of Object.entries(initial || {})) {
      const desc = byField.get(field);
      seeded[field] = desc ? seedCriterion(desc, c) : c;
    }
    return seeded;
  });
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(null);   // the field whose entities are open
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Read by the Back guard below; `picking` alone would arm the guard for a
  // criterion that renders no picker.
  const pickingDesc = picking ? byField.get(picking) : null;

  // A field in a saved filter but absent from the schema snapshot would be
  // dropped silently. Keep it and say so rather than lose a condition.
  const unknown = order.filter(f => !byField.has(f));

  // The Back guard is load-bearing, and the reason is ordering: see
  // useBuilderBack for why its listener must register before the pickers' and
  // never re-register. `open` mirrors what is actually rendered down to the
  // `pickingDesc?.entity` check, or Back would stand down with nothing shown.
  const rootRef = useBuilderBack({
    open: Boolean(adding || naming || (picking && pickingDesc?.entity)),
    onClose,
  });

  // Closing a nested layer unmounts whatever held focus, dropping it to <body>
  // where the D-pad has no zone. Restore it after the commit that mounts the
  // target; 50 ms matches the autofocus timer. `document.contains` is the same
  // check the browser makes before honouring `.focus()`.
  const restoreFocus = (id) => {
    setTimeout(() => {
      const el = registry.get(id)?.el;
      if (el && document.contains(el)) el.focus();
    }, 50);
  };

  const addField = (desc) => {
    setCriteria(prev => ({ ...prev, [desc.field]: blankCriterion(desc) }));
    setOrder(prev => (prev.includes(desc.field) ? prev : [...prev, desc.field]));
    setAdding(false);
    // The remove button, not the value: it is the row chain's leftmost stop,
    // so Right reaches every other control in order.
    restoreFocus(`fb-rm-${desc.field}`);
  };

  const removeField = (field) => {
    // The nearest surviving row (preferring the one that took its place), or
    // the footer's Add button when the last row goes. Unknown-schema fields
    // render nothing, so skip them as focus targets.
    const rendered = order.filter(f => byField.has(f));
    const at = rendered.indexOf(field);
    const rest = rendered.filter(f => f !== field);
    const neighbour = rest[at] ?? rest[at - 1];

    setCriteria((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setOrder(prev => prev.filter(f => f !== field));
    restoreFocus(neighbour ? `fb-rm-${neighbour}` : 'fb-add');
  };

  const update = (field, criterion) => setCriteria(prev => ({ ...prev, [field]: criterion }));

  // Only fields that would translate go out. Blank criteria are dropped by the
  // translator anyway; doing it here keeps the criterion count honest.
  const effective = useMemo(
    () => effectiveCriteria(order, criteria, byField),
    [order, criteria, byField],
  );

  const count = Object.keys(effective).length;

  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Saved filters are opened by Stash's web UI too, which needs its own
      // stored envelope (bare text, display-string enums), not the rows'.
      await onSave?.({
        name: name.trim(),
        objectFilter: storedCriteria(order, criteria, byField),
      });
    } catch (e) {
      setError(e.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const { ref: addRef, focused: addFocused } = useFocusable({
    id: 'fb-add',
    zone: 'filter-builder',
    onEnter: () => setAdding(true),
  });
  const { ref: applyRef, focused: applyFocused } = useFocusable({
    id: 'fb-apply',
    zone: 'filter-builder',
    onEnter: () => onApply?.(effective),
  });
  const { ref: saveRef, focused: saveFocused } = useFocusable({
    id: 'fb-save',
    zone: 'filter-builder',
    onEnter: () => setNaming(true),
  });
  const { ref: cancelRef, focused: cancelFocused } = useFocusable({
    id: 'fb-cancel',
    zone: 'filter-builder',
    onEnter: () => onClose?.(),
  });

  return (
    <div ref={rootRef} className={styles.overlay} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <span className={styles.subtitle}>
            {count === 0 ? 'No criteria yet' : `${count} ${count === 1 ? 'criterion' : 'criteria'}`}
          </span>
        </header>

        <div className={styles.body}>
          {order.length === 0 && (
            <p className={styles.empty}>
              Add a criterion below. Filters you build here can be applied
              without saving, or saved into Stash for later.
            </p>
          )}

          {unknown.length > 0 && (
            <p className={styles.warn}>
              {unknown.length} criterion{unknown.length === 1 ? '' : 'a'} in this
              filter {unknown.length === 1 ? 'is' : 'are'} not in this build's Stash
              schema and will be kept as {unknown.length === 1 ? 'it is' : 'they are'}.
            </p>
          )}

          {order.filter(f => byField.has(f)).map((field) => {
            const desc = byField.get(field);
            return (
              <CriterionRow
                key={field}
                desc={desc}
                criterion={criteria[field] || blankCriterion(desc)}
                onChange={(c) => update(field, c)}
                onRemove={() => removeField(field)}
                onPickEntities={() => setPicking(field)}
              />
            );
          })}
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            ref={addRef}
            className={`${styles.btn} ${addFocused ? styles.focused : ''}`}
            onClick={() => setAdding(true)}
          >
            + Add criterion
          </button>

          <div className={styles.spacer} />

          <button
            type="button"
            ref={cancelRef}
            className={`${styles.btn} ${cancelFocused ? styles.focused : ''}`}
            onClick={() => onClose?.()}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={saveRef}
            className={`${styles.btn} ${saveFocused ? styles.focused : ''}`}
            onClick={() => setNaming(true)}
            disabled={count === 0}
          >
            Save…
          </button>
          <button
            type="button"
            ref={applyRef}
            className={`${styles.btn} ${styles.btnPrimary} ${applyFocused ? styles.focused : ''}`}
            onClick={() => onApply?.(effective)}
            disabled={count === 0}
          >
            Apply
          </button>
        </footer>
      </div>

      {adding && (
        <FieldPicker
          filterType={filterType}
          used={order}
          onAdd={addField}
          onClose={() => { setAdding(false); restoreFocus('fb-add'); }}
        />
      )}

      {picking && pickingDesc?.entity && (
        <EntityPicker
          title={`Choose ${pickingDesc.label.toLowerCase()}`}
          entity={pickingDesc.entity}
          selected={criteria[picking]?.value?.items || []}
          onDone={(chosen) => {
            const c = criteria[picking];
            update(picking, { ...c, value: { ...(c.value || {}), items: chosen, excluded: c.value?.excluded || [] } });
            setPicking(null);
            restoreFocus(`fb-pick-${picking}`);
          }}
          onCancel={() => { setPicking(null); restoreFocus(`fb-pick-${picking}`); }}
        />
      )}

      {naming && (
        <NamePrompt
          value={name}
          saving={saving}
          error={error}
          onChange={setName}
          onCancel={() => { setNaming(false); setError(null); restoreFocus('fb-save'); }}
          onConfirm={doSave}
        />
      )}
    </div>
  );
}

