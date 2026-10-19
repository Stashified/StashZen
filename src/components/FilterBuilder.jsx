/**
 * FilterBuilder — compose a filter in the app instead of in Stash's web UI.
 *
 * WHAT IT WRITES. Stash's *stored* envelope, which is what `saveFilter`
 * persists and what `filterService` reads back — not the GraphQL shape.
 * Writing GraphQL shape here would produce a filter Stash's own web UI could
 * not open, and `filterTranslate` converts on the way out at query time
 * anyway. The four envelopes are documented in filterTranslate.js's header;
 * `blankCriterion` and `seedCriterion` in `filterBuilder/criterionDraft.js`
 * are the only places in this app that build them.
 *
 * Everything about *which* fields exist, what editor each needs and which
 * modifiers are legal comes from `filterCriteria.js` — see the note there on
 * why nothing in this path enumerates fields.
 *
 * THREE LEVELS OF OVERLAY, AND THE OUTERMOST IS THIS ONE. FieldPicker and
 * EntityPicker render as DOM children, never through a portal, because
 * `focusScopeOf` returns the *nearest* enclosing `role="dialog"` and a
 * portalled child would escape to <body>. See EntityPicker's header.
 */

import { useMemo, useState } from 'react';
import { useFocusable, registry } from '../hooks/useFocusable.js';
import { criteriaFor } from '../utils/filterCriteria.js';
import EntityPicker from './EntityPicker.jsx';
import styles from './FilterBuilder.module.css';
import {
  blankCriterion, seedCriterion, effectiveCriteria,
} from './filterBuilder/criterionDraft.js';
import { CriterionRow } from './filterBuilder/CriterionRow.jsx';
import { FieldPicker } from './filterBuilder/FieldPicker.jsx';
import { NamePrompt } from './filterBuilder/NamePrompt.jsx';
import { useBuilderBack } from './filterBuilder/useBuilderBack.js';

// ── Main ──────────────────────────────────────────────────
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

  // Ordered, so a row does not jump to the top when its value changes.
  // Seeded through `seedCriterion`: `initial` is the applied working filter,
  // which may still be in GraphQL shape (see the helper).
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

  // Declared here rather than next to the picker it feeds, because the Back
  // guard below reads it: `picking` alone would arm the guard for a criterion
  // that renders no picker, standing Back down with nothing on screen.
  const pickingDesc = picking ? byField.get(picking) : null;

  // A field present in a saved filter but absent from the schema snapshot would
  // be dropped silently. Keep it and say so, rather than letting the user's
  // filter quietly lose a condition on the round trip.
  const unknown = order.filter(f => !byField.has(f));

  // The Back guard — THE GUARD IS LOAD-BEARING, and the reason is ordering
  // rather than taste. See useBuilderBack, which explains why its listener has
  // to be registered before the pickers' and why it must never re-register.
  // Called here, before the focusables, at the position the guard has always
  // occupied.
  //
  // `open` mirrors what is actually rendered, deliberately down to the
  // `pickingDesc?.entity` check: a multi-valued criterion with no entity
  // source renders no picker, and a guard armed on `picking` alone would
  // stand Back down with nothing on screen.
  const rootRef = useBuilderBack({
    open: Boolean(adding || naming || (picking && pickingDesc?.entity)),
    onClose,
  });

  // Closing any of the nested layers unmounts whatever held focus, and focus
  // drops to <body> — the D-pad then has no zone and every horizontal press
  // is rejected. Put it back on a named control, after the commit that
  // mounts it. Same 50 ms the autofocus timer uses to let the DOM settle.
  //
  // `document.contains` rather than `isConnected`: this is the same check the
  // browser makes before honouring `.focus()`, and the target may have been
  // removed by the very update being committed.
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
    // The new row's first control. Landing on the remove button rather than
    // on the value is deliberate: it is the leftmost stop of the row's
    // declared chain, so Right reaches every other control in order.
    restoreFocus(`fb-rm-${desc.field}`);
  };

  const removeField = (field) => {
    // The nearest surviving row, preferring the one that took its place, and
    // the footer's Add button when the last row goes. The row list includes
    // fields this build's schema does not know, which render nothing — they
    // cannot be a focus target, so skip them.
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

  // Only fields that would translate to something go out. A criterion left at
  // its blank state — an empty text box — is dropped by the translator anyway;
  // dropping it here keeps the "3 criteria" count honest.
  const effective = useMemo(
    () => effectiveCriteria(order, criteria, byField),
    [order, criteria, byField],
  );

  const count = Object.keys(effective).length;

  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave?.({ name: name.trim(), objectFilter: effective });
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

