/**
 * MarkerModal, create or edit a scene marker.
 *
 * It opens over the player, and now also from the Markers tab's long-press
 * menu. The player pauses while this is up: a scene running behind a form
 * makes "the current timestamp" drift between reading and saving it.
 *
 * ## Keys
 *
 * Its own capture-phase Back handler, not the app's: the player yields every
 * key while this is open, and App's onBack chain knows nothing about it, a
 * Back that reached it would raise the exit prompt over an open form.
 * Backspace is excluded while a text field has focus; TIZEN_BACK fires anyway.
 *
 * ## Failure is not like the other writes
 *
 * Rating/organised/like update something that exists, so they can be optimistic
 * and roll back. A create has no prior state. So: an in-flight state disables
 * the buttons, close **only** on success, and on failure keep the form and
 * everything typed, with the reason in an `aria-live` line. A create that
 * silently did nothing is the one outcome this form must not have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useEditableField } from '../hooks/useEditableField.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { useArmedConfirm } from '../hooks/useArmedConfirm.js';
import {
  fetchTagOptions,
  fetchRecentMarkerTags,
  createMarker,
  updateMarker,
  destroyMarker,
  MARKER_TAG_LIMIT,
} from '../utils/markerService.js';
import { formatTime } from '../utils/format.js';
import styles from './MarkerModal.module.css';

const ZONE = 'marker-modal';
const NUDGE_SECONDS = 5;

function ModalButton({ id, label, primary, danger, disabled, onEnter, children }) {
  // `disabled` here is transient: busy, or a nudge at its bound. It is
  // `aria-disabled`, never native, because a natively disabled button cannot
  // hold focus: the press that reached the bound, or started the write, would
  // drop the cursor to <body> with the form still open.
  const { ref, focused } = useFocusable({
    id, zone: ZONE,
    onEnter: () => { if (!disabled) onEnter?.(); },
  });
  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.btn,
        primary ? styles.btnPrimary : '',
        danger ? styles.btnDanger : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={() => { if (!disabled) onEnter?.(); }}
      aria-disabled={disabled || undefined}
      // Visible text is only "5s", so the direction must come from here.
      aria-label={label}
    >
      {children ?? label}
    </button>
  );
}

export default function MarkerModal({
  sceneId,
  sceneTitle,
  marker = null,
  initialSeconds,
  duration,
  defaultTag,
  onClose,
  onCreated,
  onSaved,
  onDeleted,
}) {
  const editing = !!marker;
  // Captured once here and moved only by the nudge buttons. Not read from the
  // element at save time: the capture is what the user positioned, and a value
  // following playback would differ from what they were looking at.
  const [seconds, setSeconds] = useState(marker?.seconds ?? initialSeconds);
  const [tagId, setTagId] = useState(defaultTag?.id || null);
  const [tags, setTags] = useState([]);
  // Empty is normal for a library with no markers AND what a failed lookup
  // degrades to: the row is a shortcut, so its absence must not look broken.
  const [recentTags, setRecentTags] = useState([]);
  const [tagsFailed, setTagsFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [deleteArmed, runDelete, resetDelete] = useArmedConfirm({ timeoutMs: 5000 });
  const busy = saving || deleting;

  const title = useEditableField({
    id: 'marker-title',
    zone: ZONE,
  });

  // Read through a ref so the fetch effect is a mount effect: the player
  // derives this default while rendering, so it is a fresh object every render
  // and would refetch the tag list each time. The modal remounts per open,
  // which is what keeps it fresh.
  const defaultTagRef = useRef(defaultTag);

  // Both tag lists resolved together, so the panel cannot grow a row *above*
  // the cursor once the user has started moving (the recent row sits upstream
  // of the focused one). The optional list cannot fail the required one: its
  // catch turns a failure into "no recent row", as an empty library does.
  //
  // Loaded once on open: both orders are properties of the library, and the
  // modal remounts per open, so "once" is "fresh".
  useEffect(() => {
    let cancelled = false;
    const fallback = defaultTagRef.current;
    Promise.all([
      fetchTagOptions(),
      fetchRecentMarkerTags().catch(() => []),
    ])
      .then(([{ tags: list }, recent]) => {
        if (cancelled) return;
        // Keep the default even outside the usage head: it is the tag this
        // scene's markers already use, so it is the likeliest answer. Dropping
        // it leaves a selected tag with no chip, nothing looks selected and
        // Save refuses.
        const withDefault = fallback?.id && !list.some(t => t.id === fallback.id)
          ? [{ ...fallback, markerCount: fallback.markerCount || 0 }, ...list]
          : list;
        setTags(withDefault);
        setRecentTags(recent);
        setTagId(prev => prev || withDefault[0]?.id || null);
      })
      .catch(() => { if (!cancelled) setTagsFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // What the form can actually offer. When the lookup fails, the scene's own
  // tag is still legitimate (it came from the player's query, not the failed
  // one), and dropping it would leave the single required field unfillable:
  // a reason on screen and no way past it. Hence a one-chip list, not empty.
  const fallbackTag = defaultTagRef.current;
  const options = useMemo(
    () => (tags.length ? tags : (fallbackTag?.id ? [fallbackTag] : [])),
    [tags, fallbackTag],
  );

  // Back and `submit` are both registered once but must see the live flag, so
  // read it through a ref rather than capturing the registering render.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; });

  // Back/Escape, capture phase, see the header. The default predicate counts
  // Escape and TIZEN_BACK always; Backspace belongs to its text field.
  useBackKey(() => {
    // Mid-save there is nothing safe to close: the write may be in flight, and
    // closing would orphan it, the marker could be created with the player
    // back on screen and no confirmation shown.
    if (busyRef.current) return;
    onClose?.();
  });

  const nudge = useCallback((delta) => {
    setSeconds(prev => {
      const max = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
      return Math.max(0, Math.min(max, prev + delta));
    });
  }, [duration]);

  const submit = useCallback(async () => {
    if (busyRef.current) return;
    // The rows have different sources: `options` is the usage head (60 tags),
    // the recent row comes from markers. A tag outside the head is selectable
    // only on the recent row, so searching `options` alone rejected the form's
    // own selection with "Pick a tag first".
    const tag = options.find(t => t.id === tagId)
      || recentTags.find(t => t.id === tagId);
    if (!tag) {
      setError('Pick a tag first');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const fields = {
        seconds,
        primaryTagId: tag.id,
        primaryTagName: tag.name,
        title: title.inputRef.current?.value || '',
      };
      if (editing) {
        const saved = await updateMarker({ id: marker.id, ...fields });
        onSaved?.(saved);
      } else {
        const created = await createMarker({ sceneId, ...fields });
        onCreated?.(created);
      }
      // Only now, everything above can fail without having written anything.
      onClose?.();
    } catch (e) {
      // Keep the form, the tag and the title exactly as they were.
      setError(e?.message ? `Could not save: ${e.message}` : 'Could not save the marker');
      setSaving(false);
    }
  }, [
    sceneId, seconds, tagId, options, recentTags, title.inputRef,
    editing, marker?.id, onClose, onCreated, onSaved,
  ]);

  // Two presses, like the other destructive buttons: the first only arms.
  const remove = useCallback(() => {
    if (!editing || busyRef.current) return;
    runDelete(async () => {
      setDeleting(true);
      setError(null);
      try {
        await destroyMarker(marker.id);
        onDeleted?.(marker);
        onClose?.();
      } catch (e) {
        setError(e?.message ? `Could not delete: ${e.message}` : 'Could not delete the marker');
        setDeleting(false);
        resetDelete();
      }
    });
  }, [editing, marker, runDelete, resetDelete, onDeleted, onClose]);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={editing ? 'Edit marker' : 'Add marker'}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>{editing ? 'Edit marker' : 'Add marker'}</h2>
          {sceneTitle && <p className={styles.subtitle}>{sceneTitle}</p>}
        </header>

        <div className={styles.timeRow}>
          <ModalButton
            id="marker-nudge-back"
            label={`Back ${NUDGE_SECONDS} seconds`}
            disabled={busy || seconds <= 0}
            onEnter={() => nudge(-NUDGE_SECONDS)}
          >
            <span aria-hidden="true">⏪</span> {NUDGE_SECONDS}s
          </ModalButton>
          <span className={styles.time}>{formatTime(seconds, { padMinutes: true })}</span>
          <ModalButton
            id="marker-nudge-fwd"
            label={`Forward ${NUDGE_SECONDS} seconds`}
            disabled={busy || (duration > 0 && seconds >= duration)}
            onEnter={() => nudge(NUDGE_SECONDS)}
          >
            {NUDGE_SECONDS}s <span aria-hidden="true">⏩</span>
          </ModalButton>
        </div>

        {/*
          Only ever a shortcut: absent with no marker history, and every tag
          here also appears in the full list below, so the cursor has a route
          that does not depend on this lookup having worked.
        */}
        {recentTags.length > 0 && (
          <div className={styles.section}>
            <p className={styles.label}>
              Recently used
              <span className={styles.labelHint}>from your latest markers</span>
            </p>
            <TagRow
              idPrefix="marker-recent"
              tags={recentTags}
              selectedId={tagId}
              disabled={busy}
              onSelect={setTagId}
            />
          </div>
        )}

        <div className={styles.section}>
          <p className={styles.label}>
            Tag
            {tags.length > 0 && tags.length >= MARKER_TAG_LIMIT && (
              <span className={styles.labelHint}>most used first</span>
            )}
          </p>
          {/* Stated even though the fallback chip keeps the form usable: the
              user is choosing from a one-tag list and is owed the reason. */}
          {tagsFailed && (
            <p className={styles.error}>Could not load tags from the server.</p>
          )}
          <TagRow
            idPrefix="marker-tag"
            tags={options}
            selectedId={tagId}
            disabled={busy}
            onSelect={setTagId}
            // The tag is the one required decision, so the cursor starts on the
            // default, the user sees the guess and can accept it or move along.
            // The chips do not exist until the list arrives, so this also takes
            // focus off the rail button underneath.
            autoFocusSelected
          />
        </div>

        <div className={styles.section}>
          <p className={styles.label}>
            Label
            <span className={styles.labelHint}>optional, defaults to the tag</span>
          </p>
          <div
            ref={title.setWrapperRef}
            className={`${styles.field} ${title.selected ? styles.fieldFocused : ''}`}
          >
            <input
              ref={title.inputRef}
              className={styles.input}
              type="text"
              tabIndex={-1}
              aria-label="Marker label"
              defaultValue={marker?.title || ''}
              placeholder={options.find(t => t.id === tagId)?.name || 'Label'}
              {...title.inputHandlers}
            />
          </div>
        </div>

        {/* Announced, not merely drawn: a failed create that looked fine is the
            failure this form exists to prevent. */}
        <p className={styles.error} role="status" aria-live="polite">
          {deleting ? 'Deleting…' : saving ? 'Saving…' : (error || '')}
        </p>

        <footer className={styles.footer}>
          {editing && (
            <ModalButton
              id="marker-delete"
              label={deleteArmed ? 'Press again to delete' : 'Delete marker'}
              danger
              disabled={busy}
              onEnter={remove}
            >
              {deleteArmed ? 'Press again to delete' : 'Delete marker'}
            </ModalButton>
          )}
          <span className={styles.footerSpacer} />
          <ModalButton id="marker-cancel" label="Cancel" disabled={busy} onEnter={onClose}>
            Cancel
          </ModalButton>
          <ModalButton
            id="marker-save"
            label={editing ? 'Save' : 'Add marker'}
            primary
            disabled={busy || !tagId}
            onEnter={submit}
          >
            {saving ? 'Saving…' : (editing ? 'Save' : 'Add marker')}
          </ModalButton>
        </footer>
      </div>
    </div>
  );
}

/**
 * One scrolling row of tags, shared by both rows. `idPrefix` keeps the two
 * focusable id spaces apart when a tag is in both at once, the normal case for
 * a tag someone actually uses.
 */
function TagRow({ idPrefix, tags, selectedId, disabled, onSelect, autoFocusSelected = false }) {
  return (
    <div className={styles.tags}>
      {tags.map(t => (
        <TagChip
          key={t.id}
          id={`${idPrefix}-${t.id}`}
          tag={t}
          selected={t.id === selectedId}
          disabled={disabled}
          onSelect={() => onSelect(t.id)}
          autoFocus={autoFocusSelected && t.id === selectedId}
        />
      ))}
    </div>
  );
}

function TagChip({ id, tag, selected, disabled, onSelect, autoFocus }) {
  // `disabled` is the busy state, so it must not be native: the chip that held
  // the cursor when Save was pressed would blur to <body> mid-write.
  const { ref, focused } = useFocusable({
    id, zone: ZONE, autoFocus,
    onEnter: () => { if (!disabled) onSelect?.(); },
  });
  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.chip,
        selected ? styles.chipSelected : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={() => { if (!disabled) onSelect?.(); }}
      aria-disabled={disabled || undefined}
      aria-pressed={selected}
      // Recent-row tags carry no usage count (read off markers, not the tag
      // listing), so the count is conditional rather than "undefined".
      aria-label={tag.markerCount != null ? `${tag.name}, ${tag.markerCount} markers` : tag.name}
    >
      {tag.name}
    </button>
  );
}
