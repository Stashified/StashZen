/**
 * MarkerModal — create a scene marker without leaving the player
 *
 * Opened from the player's rail. The player pauses for as long as this is up:
 * a scene running on behind a three-field form makes "the current timestamp"
 * drift between reading it and saving it, and it is hostile besides.
 *
 * ## Keys
 *
 * Its own capture-phase Back handler, not the app's. The player yields every
 * key while this is open, and `App.jsx`'s onBack chain knows nothing about
 * this dialog — a Back that reached it would raise the exit-the-app prompt on
 * top of an open form. Backspace is excluded while a text field has focus, so
 * it still deletes a character there; TIZEN_BACK fires either way, because a
 * hardware Back has no text-editing meaning.
 *
 * ## Failure is not like the other writes
 *
 * Rating, organised and like are updates to something that already exists, so
 * they can be optimistic and roll back. A create has no prior state to roll
 * back to. So: an in-flight state that disables the buttons, close **only** on
 * success, and on failure keep the form and everything typed into it, with the
 * reason announced in an `aria-live` line. A create that silently did nothing
 * is the one outcome this form must not have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useEditableField } from '../hooks/useEditableField.js';
import { useBackKey } from '../hooks/useBackKey.js';
import {
  fetchTagOptions,
  fetchRecentMarkerTags,
  createMarker,
  MARKER_TAG_LIMIT,
} from '../utils/markerService.js';
import { formatTime } from '../utils/format.js';
import styles from './MarkerModal.module.css';

const ZONE = 'marker-modal';
const NUDGE_SECONDS = 5;

function ModalButton({ id, label, primary, disabled, onEnter, children }) {
  const { ref, focused } = useFocusable({ id, zone: ZONE, onEnter });
  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.btn,
        primary ? styles.btnPrimary : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={onEnter}
      disabled={disabled}
      // The nudge buttons' visible text is only "5s", so the direction has to
      // come from here or the two are indistinguishable when spoken.
      aria-label={label}
    >
      {children ?? label}
    </button>
  );
}

export default function MarkerModal({
  sceneId,
  sceneTitle,
  initialSeconds,
  duration,
  defaultTag,
  onClose,
  onCreated,
}) {
  // The timestamp is captured once, here, and only ever moved by the nudge
  // buttons. It is not read from the element at save time: the capture is the
  // thing the user positioned, and a value that follows playback would be a
  // different number from the one they were looking at.
  const [seconds, setSeconds] = useState(initialSeconds);
  const [tagId, setTagId] = useState(defaultTag?.id || null);
  const [tags, setTags] = useState([]);
  // Empty is the ordinary state of a library that has never had a marker, and
  // it is also what a failed lookup of this one list degrades to: the row is a
  // shortcut, so its absence must never look like a broken form.
  const [recentTags, setRecentTags] = useState([]);
  const [tagsFailed, setTagsFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const title = useEditableField({
    id: 'marker-title',
    zone: ZONE,
  });

  // Read through a ref so the fetch effect below is a mount effect. The
  // player derives this default while rendering, so it arrives as a fresh
  // object every time — as a dependency it would refetch the tag list on
  // every render, and the modal is remounted for each open, which is what
  // actually keeps it fresh.
  const defaultTagRef = useRef(defaultTag);

  // Both tag lists, resolved together. Together rather than as each arrives so
  // the panel cannot grow a row *above* the cursor once the user has started
  // moving — the recent row is inserted upstream of the one that holds focus.
  //
  // The optional list cannot fail the required one: its own catch turns a
  // failure into "no recent row", which is the same picture a library with no
  // marker history shows.
  //
  // Loaded once, on open: both orderings are properties of the library and do
  // not change while the form is up, and the modal is remounted for every open,
  // which is what makes "once" the same as "fresh" here.
  useEffect(() => {
    let cancelled = false;
    const fallback = defaultTagRef.current;
    Promise.all([
      fetchTagOptions(),
      fetchRecentMarkerTags().catch(() => []),
    ])
      .then(([{ tags: list }, recent]) => {
        if (cancelled) return;
        // Keep the default even when it is outside the usage head. It is the
        // tag this scene's own markers already use, which makes it the most
        // likely answer regardless of how rarely the library uses it — and
        // dropping it would leave the form with a selected tag that has no
        // chip, so nothing would look selected and Save would refuse.
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

  // What the form can actually offer.
  //
  // When the library lookup fails, the tag this scene already uses is still a
  // legitimate answer — it came from the player's own query, not from the
  // failed one — and dropping it would leave a form whose single required
  // field cannot be filled: the reason on screen, and no way past it. So the
  // fallback is a one-chip list rather than an empty one.
  const fallbackTag = defaultTagRef.current;
  const options = useMemo(
    () => (tags.length ? tags : (fallbackTag?.id ? [fallbackTag] : [])),
    [tags, fallbackTag],
  );

  // The Back handler below and `submit` both need to know a write is in
  // flight, and both are registered once — so the flag is read through a ref
  // rather than captured from the render that registered them.
  const savingRef = useRef(false);
  useEffect(() => { savingRef.current = saving; });

  // Back/Escape, capture phase — see the header. The default predicate is the
  // hand-written rule: Escape and TIZEN_BACK always count, Backspace belongs
  // to the text field it was typed in.
  useBackKey(() => {
    // Mid-save there is nothing safe to close: the write may already be in
    // flight, and closing would orphan it — the marker might be created
    // with the player already back on screen and no confirmation shown.
    if (savingRef.current) return;
    onClose?.();
  });

  const nudge = useCallback((delta) => {
    setSeconds(prev => {
      const max = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
      return Math.max(0, Math.min(max, prev + delta));
    });
  }, [duration]);

  const submit = useCallback(async () => {
    if (savingRef.current) return;
    // The two rows are built from different sources: `options` is the usage
    // head (60 tags), while the recent row comes from the markers themselves.
    // A tag used for a marker but outside that head is selectable on the
    // recent row and nowhere else, so looking it up in `options` alone made
    // the form reject its own selection with "Pick a tag first".
    const tag = options.find(t => t.id === tagId)
      || recentTags.find(t => t.id === tagId);
    if (!tag) {
      setError('Pick a tag first');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createMarker({
        sceneId,
        seconds,
        primaryTagId: tag.id,
        primaryTagName: tag.name,
        title: title.inputRef.current?.value || '',
      });
      // Only now. Everything above can fail without having written anything.
      onCreated?.(created);
      onClose?.();
    } catch (e) {
      // Keep the form, the tag and the title exactly as they were.
      setError(e?.message ? `Could not save: ${e.message}` : 'Could not save the marker');
      setSaving(false);
    }
  }, [sceneId, seconds, tagId, options, recentTags, title.inputRef, onClose, onCreated]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Add marker">
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>Add marker</h2>
          {sceneTitle && <p className={styles.subtitle}>{sceneTitle}</p>}
        </header>

        <div className={styles.timeRow}>
          <ModalButton
            id="marker-nudge-back"
            label={`Back ${NUDGE_SECONDS} seconds`}
            disabled={saving || seconds <= 0}
            onEnter={() => nudge(-NUDGE_SECONDS)}
          >
            <span aria-hidden="true">⏪</span> {NUDGE_SECONDS}s
          </ModalButton>
          <span className={styles.time}>{formatTime(seconds, { padMinutes: true })}</span>
          <ModalButton
            id="marker-nudge-fwd"
            label={`Forward ${NUDGE_SECONDS} seconds`}
            disabled={saving || (duration > 0 && seconds >= duration)}
            onEnter={() => nudge(NUDGE_SECONDS)}
          >
            {NUDGE_SECONDS}s <span aria-hidden="true">⏩</span>
          </ModalButton>
        </div>

        {/*
          Recently used, and only ever as a shortcut: the row is absent on a
          library with no marker history, and a tag appearing here also appears
          in the full list below, so the cursor has one way to reach it that
          does not depend on this lookup having worked.
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
              disabled={saving}
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
          {/* The failure is stated even when the fallback chip below keeps the
              form usable — the user is choosing from a one-tag list and is
              owed the reason. */}
          {tagsFailed && (
            <p className={styles.error}>Could not load tags from the server.</p>
          )}
          <TagRow
            idPrefix="marker-tag"
            tags={options}
            selectedId={tagId}
            disabled={saving}
            onSelect={setTagId}
            // The tag is the form's one required decision, so the cursor
            // starts on the default rather than on a button — the user sees
            // what has been guessed for them and can accept it or move along
            // the row. The chips do not exist until the list arrives, so
            // this also lands the focus that takes the cursor off the rail
            // button underneath.
            autoFocusSelected
          />
        </div>

        <div className={styles.section}>
          <p className={styles.label}>
            Label
            <span className={styles.labelHint}>optional — defaults to the tag</span>
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
              placeholder={options.find(t => t.id === tagId)?.name || 'Label'}
              {...title.inputHandlers}
            />
          </div>
        </div>

        {/* Announced rather than merely drawn: a create that failed while the
            form looked fine is the failure this form exists to prevent. */}
        <p className={styles.error} role="status" aria-live="polite">
          {saving ? 'Saving…' : (error || '')}
        </p>

        <footer className={styles.footer}>
          <ModalButton id="marker-cancel" label="Cancel" disabled={saving} onEnter={onClose}>
            Cancel
          </ModalButton>
          <ModalButton
            id="marker-save"
            label="Add marker"
            primary
            disabled={saving || !tagId}
            onEnter={submit}
          >
            {saving ? 'Saving…' : 'Add marker'}
          </ModalButton>
        </footer>
      </div>
    </div>
  );
}

/**
 * One scrolling row of tags. Both rows are the same control with a different
 * list, so they share this rather than the chip mapping being written twice —
 * `idPrefix` is what keeps the two focusable id spaces apart when a tag is in
 * both rows at once, which is the normal case for a tag someone actually uses.
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
  const { ref, focused } = useFocusable({ id, zone: ZONE, onEnter: onSelect, autoFocus });
  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.chip,
        selected ? styles.chipSelected : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      // The recent row's tags arrive without a usage count — they are read off
      // markers, not off the tag listing — so the count is conditional rather
      // than interpolated as "undefined".
      aria-label={tag.markerCount != null ? `${tag.name}, ${tag.markerCount} markers` : tag.name}
    >
      {tag.name}
    </button>
  );
}
