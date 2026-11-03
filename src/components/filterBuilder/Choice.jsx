import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { isBackCode } from '../../utils/input.js';
import styles from '../FilterBuilder.module.css';

// Modelled on ControlsPanel's, which is not extracted: that one is scoped to
// the controls bar and needs neither overlay concern here. Inside a dialog this
// needs `data-focus-trap` to keep an open menu a closed set.
export function Choice({ id, label, value, options, onChange, disabled, renderLabel,
                  zone = 'filter-builder', nextId = null }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  const { ref, focused } = useFocusable({
    id,
    zone,
    nextId,
    onEnter: () => { if (!disabled) setOpen(o => !o); },
    disabled,
  });

  // Closing unmounts the focused option, dropping focus to <body>. Put it back
  // on the trigger.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) ref.current?.focus();
    wasOpenRef.current = open;
  }, [open, ref]);

  useEffect(() => {
    if (!open) return undefined;
    const el = wrapperRef.current;
    if (!el) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape' || isBackCode(e.keyCode)) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    el.addEventListener('keydown', handler, true);
    return () => el.removeEventListener('keydown', handler, true);
  }, [open]);

  const shown = renderLabel ? renderLabel(value) : (options.find(o => o.value === value)?.label ?? value ?? '–');

  // Open on the current value, so a list that no longer fits in view still
  // starts where the user is looking.
  const selectedIndex = options.findIndex(o => o.value === value);

  return (
    <div className={styles.choice} ref={wrapperRef} data-focus-trap={open ? '' : undefined}>
      {label && <span className={styles.choiceLabel}>{label}</span>}
      <button
        ref={ref}
        type="button"
        className={`${styles.choiceBtn} ${focused ? styles.focused : ''} ${disabled ? styles.disabled : ''}`}
        onClick={() => { if (!disabled) setOpen(o => !o); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        <span>{shown}</span>
        <span className={styles.choiceCaret} aria-hidden="true">▾</span>
      </button>

      {/* A sheet over the dialog, not a list under the trigger: the dialog's
          scroll area clipped the old menu to two rows of the eight a modifier
          offers. Rendered here rather than portalled so `data-focus-trap` above
          still encloses the options. */}
      {open && (
        <div className={styles.choiceSheet} onClick={() => setOpen(false)}>
          <div
            className={styles.choiceMenu}
            role="listbox"
            onClick={(e) => e.stopPropagation()}
          >
            {options.map((opt, i) => (
              <ChoiceOption
                key={opt.value}
                parentId={id}
                opt={opt}
                selected={opt.value === value}
                autoFocus={i === (selectedIndex >= 0 ? selectedIndex : 0)}
                onSelect={() => { onChange(opt.value); setOpen(false); }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChoiceOption({ parentId, opt, selected, autoFocus, onSelect }) {
  const { ref, focused } = useFocusable({
    id: `${parentId}-opt-${opt.value}`,
    zone: `fbdrop-${parentId}`,
    onEnter: onSelect,
  });
  // The menu opens as its own surface; without this the D-pad still points at
  // the trigger and the first press is a no-op the user reads as a dead list.
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, ref]);
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.choiceItem} ${selected ? styles.selected : ''} ${focused ? styles.focused : ''}`}
      onClick={onSelect}
      role="option"
      aria-selected={selected}
    >
      {opt.label}
    </button>
  );
}
