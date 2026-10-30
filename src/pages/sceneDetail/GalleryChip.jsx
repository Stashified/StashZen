import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SceneDetailPage.module.css';

// A hand-off, not an overlay: Enter opens the Images tab filtered to this
// gallery. The parent must *not* also close the scene page, the tab change
// already unmounts it, and closing here would race that effect and restore
// focus onto a card on the tab being replaced.
//
// Same focusable-chip pattern and marker styling as MarkerChip: from the D-pad
// a chip is a chip.
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
