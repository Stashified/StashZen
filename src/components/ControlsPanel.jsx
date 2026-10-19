/**
 * ControlsPanel — Configurable controls bar
 *
 * Sort dropdown supports BOTH legacy flat sortOptions AND new grouped
 * sortGroups. If sortGroups is provided, it takes precedence.
 *
 * sortGroups shape: [{ group: 'Title', options: [{ value, label }] }]
 *
 * ## Zone: 'controls' — kept, with `crossZone` to open the way up
 *
 * The bar keeps a zone of its own, for the reason it always had one: a zone is
 * a set of elements Left/Right move within, so 'controls' keeps the bar's
 * controls walkable in a row while nothing in the grid can step sideways into
 * them. In the 4-column grid, with nothing guarding it, Right from video-2
 * went to the mute toggle, 21px to its right and 166px up (score
 * 21 + 1.5×166 = 269), beating video-3 at 276px right (276 + 1.5×4 = 282).
 *
 * What that zone also did was make the bar unreachable from below: useKeyHandler
 * adds CROSS_ZONE_PENALTY (100000) to any Up/Down candidate from another zone,
 * so from the first card row the rail row above always won, however much
 * nearer the filter looked. Up out of the cards landed on the nav instead of
 * on the control it appears to point at, which is the thing the user asked to
 * have fixed.
 *
 * Every control here therefore passes `crossZone: true`. It is read off the
 * *candidate*, which waives that penalty and lets Up out of the first card row
 * reach the Filter dropdown (score 136, against 502 for the rail row nearest
 * above it). It is also read off the *mover*, and that half is not optional:
 * a zone is symmetric, so keeping the grid out of the bar sideways is the same
 * rule as keeping the bar out of the rail sideways, and Left from the Filter
 * dropdown would do nothing at all without it.
 *
 * The two directions that remain shut are the ones that are actually wrong.
 * Right from a card goes to the next card along, not to the mute toggle 166px
 * above it; Right from a rail row goes into the cards, not into the bar.
 *
 * The rail's mirror of this is `verticalOnly` — a different flag, because it
 * is a different fact. See useFocusable for both, and NavRail.jsx for the rail.
 *
 * The dropdown options keep a zone of their own (`dropdown-${parentId}`) and
 * carry neither flag. That one is unrelated and load-bearing for the same
 * reason it always was: an open menu is a closed set. `data-focus-trap`
 * confines it too, but the zone keeps Left/Right inside the list either way.
 */

import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { TIZEN_BACK, isTextInput } from '../utils/input.js';
import styles from './ControlsPanel.module.css';
import SearchInput from './SearchInput.jsx';
import MuteToggle from './MuteToggle.jsx';
import { flattenSortGroups } from '../utils/sortGroups.js';

// ── Dropdown state + remote handling, shared by both dropdowns ──
//
// While a dropdown is open it owns the D-pad. The wrapper carries
// `data-focus-trap`, which confines spatial navigation to it (useKeyHandler's
// `focusScopeOf`). Before that, Down on the last option looked for a
// candidate ahead, found none in this zone, and took one from the grid
// instead — moving the user onto the scene cards while the menu sat open
// over them.
//
// Back closes the dropdown rather than reaching App, where it would raise the
// exit prompt behind an open menu.
function useDropdown(id) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const { ref: triggerRef, focused } = useFocusable({
    id,
    zone: 'controls',
    crossZone: true,
    onEnter: () => setOpen(o => !o),
  });

  // Closing unmounts whichever option held focus, so the browser drops focus
  // to <body> — where useKeyHandler has neither a current element nor a zone,
  // and horizontal nav matches nothing at all. Put focus back on the trigger.
  // Guarded on a real open→closed transition so mounting doesn't steal it.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) triggerRef.current?.focus();
    wasOpenRef.current = open;
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const el = wrapperRef.current;
    if (!el) return;

    // Capture phase on the wrapper: stopping the event here prevents it
    // reaching the target and bubbling back up to useKeyHandler's window
    // listener, so App never sees this Back.
    const handler = (e) => {
      if (e.key === 'Escape' || e.keyCode === TIZEN_BACK ||
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

// ── Generic Mode dropdown (still flat, only a few options) ─
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

// ── Grouped Sort dropdown ─────────────────────────────────
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

// ── Toggle ─────────────────────────────────────────────────
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

// A push button in the bar. Deliberately not `ToggleBtn` with `active={false}`:
// that carries `aria-pressed`, which announces a toggle that can be un-pressed.
// Opening the builder is an action, and the only thing it has in common with a
// toggle is the styling.
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

// ── Stepper ────────────────────────────────────────────────
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
        disabled={value <= min}
        aria-label={`Decrease ${id}`}
      >−</button>
      <span className={styles.stepperVal}>{value}</span>
      <button
        ref={incRef}
        className={`${styles.stepperBtn} ${incFocused ? styles.focused : ''}`}
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label={`Increase ${id}`}
      >+</button>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────
export default function ControlsPanel({
  controls,
  onChange,
  modeOptions = null,
  // The view mode is per section and lives in the settings store, not in
  // `controls` — so it arrives as its own value/onChange pair. Both fall back
  // to the old `controls.mode` / `onChange({ mode })` when absent, which is
  // what keeps the panels that were not part of that move (the performer
  // detail page's scoped copy, and the harness drivers) working unchanged.
  mode = null,
  onModeChange = null,
  sortOptions = [],       // legacy flat list (still supported)
  sortGroups = null,      // new grouped sort option
  showOrder = true,
  showGridSize = true,
  filterOptions = null,    // [{ value, label }] or null to hide
  onBuildFilter = null,    // opens the filter builder; null hides the action
  showSearch = false,
  previewMuted = true,
  onMuteToggle = null,
}) {
  const { sort, order, cols } = controls;
  const activeMode = mode ?? controls.mode;
  const changeMode = onModeChange ?? (v => onChange({ mode: v }));
  const showDivider = (a, b) => a && b;

  // Use grouped if provided, else fall back to flat
  const hasSort = (sortGroups && sortGroups.length) || sortOptions.length;

  return (
    <div className={styles.panel} role="toolbar" aria-label="Controls">
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
          {/* Beside the dropdown, because it is the other half of the same
              job: the dropdown picks a filter someone else made, this makes
              one. Hidden on tabs with no filter mode rather than disabled —
              there is nothing on those tabs for it to build. */}
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
  );
}
