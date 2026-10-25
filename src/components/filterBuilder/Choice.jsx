import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { TIZEN_BACK } from '../../utils/input.js';
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
      if (e.key === 'Escape' || e.keyCode === TIZEN_BACK) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    el.addEventListener('keydown', handler, true);
    return () => el.removeEventListener('keydown', handler, true);
  }, [open]);

  const shown = renderLabel ? renderLabel(value) : (options.find(o => o.value === value)?.label ?? value ?? '—');

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

      {open && (
        <div className={styles.choiceMenu} role="listbox">
          {options.map((opt) => (
            <ChoiceOption
              key={opt.value}
              parentId={id}
              opt={opt}
              selected={opt.value === value}
              onSelect={() => { onChange(opt.value); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChoiceOption({ parentId, opt, selected, onSelect }) {
  const { ref, focused } = useFocusable({
    id: `${parentId}-opt-${opt.value}`,
    zone: `fbdrop-${parentId}`,
    onEnter: onSelect,
  });
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
