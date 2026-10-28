/**
 * MarkerDeletePrompt, the confirmation in front of a marker delete.
 *
 * The menu row is one press from the card, so the write itself asks first.
 * Delete stays open with the reason on failure; closing on a failed request
 * would leave the marker in place with no evidence anything was tried.
 */

import { useCallback, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { destroyMarker } from '../utils/markerService.js';
import { formatTime } from '../utils/format.js';
import styles from './MarkerModal.module.css';

const ZONE = 'marker-delete';

function PromptButton({ id, label, danger, primary, disabled, autoFocus, onEnter }) {
  // `disabled` is the in-flight state. Native `disabled` would blur the pressed
  // button, and a failed delete leaves this prompt open with nothing focused.
  const { ref, focused } = useFocusable({
    id, zone: ZONE, autoFocus,
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
    >
      {label}
    </button>
  );
}

export default function MarkerDeletePrompt({ marker, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const busyRef = useRef(false);

  const close = useCallback(() => {
    if (busyRef.current) return;
    onClose?.();
  }, [onClose]);

  useBackKey(close);

  const confirm = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await destroyMarker(marker.id);
      onDeleted?.(marker);
      onClose?.();
    } catch (e) {
      busyRef.current = false;
      setBusy(false);
      setError(e?.message ? `Could not delete: ${e.message}` : 'Could not delete the marker');
    }
  }, [marker, onDeleted, onClose]);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Delete marker"
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>Delete marker?</h2>
          <p className={styles.subtitle}>
            {marker.title}
            {marker.scene?.title
              ? ` at ${formatTime(marker.seconds)} in ${marker.scene.title}`
              : ''}
          </p>
        </header>

        <p className={styles.error} role="status" aria-live="polite">
          {busy ? 'Deleting…' : (error || '')}
        </p>

        <footer className={styles.footer}>
          <PromptButton
            id="marker-delete-cancel"
            label="Cancel"
            disabled={busy}
            autoFocus
            onEnter={close}
          />
          <PromptButton
            id="marker-delete-confirm"
            label="Delete marker"
            danger
            disabled={busy}
            onEnter={confirm}
          />
        </footer>
      </div>
    </div>
  );
}
