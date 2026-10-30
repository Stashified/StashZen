/**
 * ControlsPanel, configurable controls bar.
 *
 * Sort accepts legacy flat `sortOptions` or grouped `sortGroups` (which wins):
 * `[{ group: 'Title', options: [{ value, label }] }]`.
 *
 * ## Zone: 'controls', with `crossZone` to open the way up
 *
 * A zone is what Left/Right move within, so 'controls' keeps the bar's controls
 * walkable in a row and the grid from stepping sideways into them, without it,
 * Right from video-2 went to the mute toggle, 21px right and 166px up, beating
 * video-3.
 *
 * The zone also made the bar unreachable from below: useKeyHandler adds
 * CROSS_ZONE_PENALTY (100000) to any Up/Down candidate from another zone, so Up
 * out of the first card row always landed on the nav rail. Every control here
 * therefore passes `crossZone: true`, read off both candidate and mover, the
 * mover half is not optional because a zone is symmetric, and Left from the
 * Filter dropdown would do nothing otherwise.
 *
 * The directions that stay shut are the wrong ones: Right from a card goes to
 * the next card, and from a rail row into the cards, not into the bar. The
 * rail's mirror is `verticalOnly` (see useFocusable, NavRail.jsx).
 *
 * Dropdown options keep their own zone (`dropdown-${parentId}`) with neither
 * flag: an open menu is a closed set, and the zone keeps Left/Right inside it.
 */

import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { isBackCode, isTextInput } from '../utils/input.js';
import styles from './ControlsPanel.module.css';
import SearchInput from './SearchInput.jsx';
import MuteToggle from './MuteToggle.jsx';
import { flattenSortGroups } from '../utils/sortGroups.js';

// ── Dropdown state + remote handling, shared by both dropdowns ──
//
// While open a dropdown owns the D-pad: the wrapper's `data-focus-trap`
// confines spatial nav to it (useKeyHandler's `focusScopeOf`). Without it, Down
// on the last option took a candidate from the grid. Back closes the dropdown
// rather than reaching App, which would raise the exit prompt behind it.
function useDropdown(id) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const { ref: triggerRef, focused } = useFocusable({
    id,
    zone: 'controls',
    crossZone: true,
    onEnter: () => setOpen(o => !o),
  });

  // Closing unmounts the focused option, dropping focus to <body> where
  // useKeyHandler has no element or zone and horizontal nav matches nothing.
  // Restore it to the trigger, guarded on a real open→closed transition.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) triggerRef.current?.focus();
    wasOpenRef.current = open;
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const el = wrapperRef.current;
    if (!el) return;

    // Capture phase on the wrapper: stopping here prevents the event reaching
    // the target and bubbling to useKeyHandler's window listener, so App never
    // sees this Back.
    const handler = (e) => {
      if (e.key === 'Escape' || isBackCode(e.keyCode) ||
          (e.key === 'Backspace' && !isTextInput(document.activeElement))) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    el.addEventListener('keydown', handler, true);
    return () => el.removeEventListener('keydown', handler, true);
  }, [open]);

  return { open, setOpen, triggerRef, focused, wrapperRef };
}

function SelectControl({ id, label, options, value, onChange }) {
  const { open, setOpen, triggerRef, focused, wrapperRef } = useDropdown(id);

  const currentLabel = options.find(o => o.value === value)?.label || value;

  return (
    <div className={styles.control}>
      <span className={styles.controlLabel}>{label}</span>
      <div className={styles.selectWrapper} ref={wrapperRef} data-focus-trap={open ? '' : undefined}>
        <button
          ref={triggerRef}
          className={`${styles.selectBtn} ${focused ? styles.focused : ''} ${open ? styles.open : ''}`}
          onClick={() => setOpen(o => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span>{currentLabel}</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
            <path d="M2 5l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {open && (
          <div className={styles.dropdown} role="listbox">
            {options.map(opt => (
              <DropdownOption
                key={opt.value}
                opt={opt}
                selected={value === opt.value}
                onSelect={(v) => { onChange(v); setOpen(false); }}
                parentId={id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SortGroupedControl({ id, label, groups, value, onChange }) {
  const { open, setOpen, triggerRef, focused, wrapperRef } = useDropdown(id);

  const flat = flattenSortGroups(groups);
  const currentLabel = flat.find(o => o.value === value)?.label || value;

  return (
    <div className={styles.control}>
      <span className={styles.controlLabel}>{label}</span>
      <div className={styles.selectWrapper} ref={wrapperRef} data-focus-trap={open ? '' : undefined}>
        <button
          ref={triggerRef}
          className={`${styles.selectBtn} ${focused ? styles.focused : ''} ${open ? styles.open : ''}`}
          onClick={() => setOpen(o => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span>{currentLabel}</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
            <path d="M2 5l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {open && (
          <div className={`${styles.dropdown} ${styles.dropdownScrollable}`} role="listbox">
            {groups.map((group, gi) => (
              <div key={group.group} className={styles.dropdownGroup}>
                <div className={styles.dropdownGroupHeader}>{group.group}</div>
                {group.options.map(opt => (
                  <DropdownOption
                    key={opt.value}
                    opt={opt}
                    selected={value === opt.value}
                    onSelect={(v) => { onChange(v); setOpen(false); }}
                    parentId={id}
                  />
                ))}
                {gi < groups.length - 1 && <div className={styles.dropdownGroupDivider} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DropdownOption({ opt, selected, onSelect, parentId }) {
  const { ref, focused } = useFocusable({
    id: `${parentId}-opt-${opt.value}`,
    zone: `dropdown-${parentId}`,
    onEnter: () => onSelect(opt.value),
  });

  return (
    <button
      ref={ref}
      className={`${styles.dropdownItem} ${selected ? styles.selected : ''} ${focused ? styles.focused : ''}`}
      onClick={() => onSelect(opt.value)}
      role="option"
      aria-selected={selected}
    >
      {opt.label}
      {selected && <span className={styles.check}>✓</span>}
    </button>
  );
}

function ToggleBtn({ id, label, active, onClick }) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'controls',
    crossZone: true,
    onEnter: onClick,
  });

  return (
    <button
      ref={ref}
      className={`${styles.toggleBtn} ${active ? styles.active : ''} ${focused ? styles.focused : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

// Deliberately not `ToggleBtn` with `active={false}`: that carries
// `aria-pressed`, announcing a toggle that can be un-pressed. Opening the
// builder is an action and shares only the styling.
function PanelButton({ id, label, onClick }) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'controls',
    crossZone: true,
    onEnter: onClick,
  });

  return (
    <button
      ref={ref}
      className={`${styles.toggleBtn} ${focused ? styles.focused : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// A one-press filter, same zone and `crossZone` rules as the controls above.
// `aria-pressed`, not a radio: the chips combine.
function QuickChip({ id, label, active, onClick }) {
  const { ref, focused } = useFocusable({
    id: `quick-${id}`,
    zone: 'controls',
    crossZone: true,
    onEnter: onClick,
  });

  return (
    <button
      ref={ref}
      className={`${styles.quickChip} ${active ? styles.quickChipActive : ''} ${focused ? styles.focused : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function NumberStepper({ id, value, min, max, onChange }) {
  const { ref: decRef, focused: decFocused } = useFocusable({
    id: `${id}-dec`,
    zone: 'controls',
    crossZone: true,
    onEnter: () => onChange(Math.max(min, value - 1)),
  });
  const { ref: incRef, focused: incFocused } = useFocusable({
    id: `${id}-inc`,
    zone: 'controls',
    crossZone: true,
    onEnter: () => onChange(Math.min(max, value + 1)),
  });

  return (
    <div className={styles.stepper}>
      <button
        ref={decRef}
        className={`${styles.stepperBtn} ${decFocused ? styles.focused : ''}`}
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-disabled={value <= min}
        aria-label={`Decrease ${id}`}
      >−</button>
      <span className={styles.stepperVal}>{value}</span>
      <button
        ref={incRef}
        className={`${styles.stepperBtn} ${incFocused ? styles.focused : ''}`}
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-disabled={value >= max}
        aria-label={`Increase ${id}`}
      >+</button>
    </div>
  );
}

export default function ControlsPanel({
  controls,
  onChange,
  modeOptions = null,
  // View mode is per section and lives in the settings store, not `controls`,
  // so it arrives as its own pair. Both fall back to `controls.mode` /
  // `onChange({ mode })` when absent, that keeps the performer detail page's
  // scoped copy and the harness drivers working unchanged.
  mode = null,
  onModeChange = null,
  sortOptions = [],       // legacy flat list
  sortGroups = null,      // grouped sort, takes precedence
  showOrder = true,
  showGridSize = true,
  filterOptions = null,    // [{ value, label }] or null to hide
  onBuildFilter = null,    // opens the filter builder; null hides the action
  showSearch = false,
  previewMuted = true,
  onMuteToggle = null,
  // The one-press chips, as definitions plus the ids in force. A tab that
  // declares none renders no row.
  quickFilterOptions = [],
  quickFilters = [],
  onQuickFilterToggle = null,
}) {
  const { sort, order, cols } = controls;
  const activeMode = mode ?? controls.mode;
  const changeMode = onModeChange ?? (v => onChange({ mode: v }));
  const showDivider = (a, b) => a && b;

  const hasSort = (sortGroups && sortGroups.length) || sortOptions.length;
  const hasQuick = quickFilterOptions.length > 0 && onQuickFilterToggle;

  return (
    <div className={styles.panel} role="toolbar" aria-label="Controls">
      <div className={styles.mainRow}>
        {showSearch && (
          <>
            <SearchInput
              value={controls.search || ''}
              onChange={v => onChange({ search: v })}
            />
            {(modeOptions || sortGroups || sortOptions.length > 0 || showOrder || filterOptions || showGridSize) && (
              <div className={styles.divider} />
            )}
          </>
        )}
        {modeOptions && (
          <SelectControl
            id="ctrl-mode"
            label="Mode"
            options={modeOptions}
            value={activeMode}
            onChange={changeMode}
          />
        )}

        {showDivider(modeOptions, hasSort) && <div className={styles.divider} />}

        {sortGroups && sortGroups.length > 0 && (
          <SortGroupedControl
            id="ctrl-sort"
            label="Sort"
            groups={sortGroups}
            value={sort}
            onChange={v => onChange({ sort: v })}
          />
        )}

        {!sortGroups && sortOptions.length > 0 && (
          <SelectControl
            id="ctrl-sort"
            label="Sort"
            options={sortOptions}
            value={sort}
            onChange={v => onChange({ sort: v })}
          />
        )}

        {showOrder && (
          <div className={styles.orderGroup}>
            <ToggleBtn
              id="ctrl-asc"
              label="ASC ↑"
              active={order === 'asc'}
              onClick={() => onChange({ order: 'asc' })}
            />
            <ToggleBtn
              id="ctrl-desc"
              label="DESC ↓"
              active={order === 'desc'}
              onClick={() => onChange({ order: 'desc' })}
            />
          </div>
        )}

        {filterOptions && (
          <>
            {showDivider(hasSort || showOrder, true) && <div className={styles.divider} />}
            <SelectControl
              id="ctrl-filter"
              label="Filter"
              options={filterOptions}
              value={controls.filterId || ''}
              onChange={v => onChange({ filterId: v || null })}
            />
            {/* Beside the dropdown: that picks a saved filter, this makes one.
                Hidden, not disabled, on tabs with no filter mode: there is
                nothing there for it to build. */}
            {onBuildFilter && (
              <PanelButton id="ctrl-build-filter" label="Build…" onClick={onBuildFilter} />
            )}
          </>
        )}

        {showGridSize && showDivider(hasSort || showOrder || filterOptions, true) && (
          <div className={styles.divider} />
        )}

        {showGridSize && (
          <div className={styles.control}>
            <span className={styles.controlLabel}>Columns</span>
            <NumberStepper
              id="grid-cols"
              value={cols}
              min={1}
              max={8}
              onChange={v => onChange({ cols: v })}
            />
          </div>
        )}
        {onMuteToggle && (
          <>
            {showGridSize && <div className={styles.divider} />}
            <MuteToggle muted={previewMuted} onToggle={onMuteToggle} />
          </>
        )}
      </div>

      {hasQuick && (
        <div className={styles.quickRow}>
          <span className={styles.controlLabel}>Quick</span>
          {quickFilterOptions.map(opt => (
            <QuickChip
              key={opt.id}
              id={opt.id}
              label={opt.label}
              active={quickFilters.includes(opt.id)}
              onClick={() => onQuickFilterToggle(opt.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
