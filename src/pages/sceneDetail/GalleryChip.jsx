import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SceneDetailPage.module.css';

// ── Gallery chip ────────────────────────────────────────────
//
// A hand-off, not an overlay: Enter leaves this scene and opens the Galleries
// tab focused on this gallery. The parent deliberately does *not* close the
// scene detail page as well — switching tabs already unmounts it through
// useDetailSelection's tab-change effect, and closing it here too would race
// that effect and restore focus to a card on the tab being replaced.
//
// Same focusable-chip pattern as MarkerChip, including the shared marker
// styling: from the D-pad a chip is a chip, and a second visual language for
// this row would only be noise.
export function GalleryChip({ gallery, onGallerySelect }) {
  const { ref, focused } = useFocusable({
    id: `scene-gallery-${gallery.id}`,
    zone: 'scene-detail',
    onEnter: () => onGallerySelect?.(gallery),
  });
  return (
    <button
      ref={ref}
      className={`${styles.markerChip} ${focused ? styles.markerFocused : ''}`}
      onClick={() => onGallerySelect?.(gallery)}
      aria-label={`Browse gallery: ${gallery.title}`}
    >
      <span className={styles.markerName}>{gallery.title}</span>
    </button>
  );
}
