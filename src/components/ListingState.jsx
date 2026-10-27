/**
 * ListingState, the card area when there are no cards yet: loading, error, or
 * empty results.
 *
 * Focusable on purpose. Without it an empty view has no target in the content
 * column, so Right out of the nav rail found nothing and a filtered-to-nothing
 * listing left the D-pad with no way back in. It shares the cards' zone so
 * Left/Right rejoin the rail and the cards. Up is declared to the controls bar:
 * the box sits mid-column, where geometry prefers whichever rail row is nearest.
 */

import { useFocusable } from '../hooks/useFocusable.js';

// Module constant, not a render literal, see useFocusable's `nextId` note.
// Falls through to geometry on a tab with no sort control.
const UP_EDGE = { up: 'ctrl-sort' };

export default function ListingState({
  id,
  styles,
  text,
  loading = false,
  spinnerLabel = null,
  error = false,
}) {
  const { ref, focused } = useFocusable({ id, zone: 'grid', nextId: UP_EDGE });

  return (
    <div
      ref={ref}
      className={styles.state}
      style={focused ? {
        outline: '2px solid var(--accent)',
        outlineOffset: 12,
        borderRadius: 4,
      } : undefined}
    >
      {loading && <div className={styles.spinner} aria-label={spinnerLabel ?? undefined} />}
      <p className={styles.stateText} style={error ? { color: 'var(--red)' } : undefined}>
        {text}
      </p>
    </div>
  );
}
