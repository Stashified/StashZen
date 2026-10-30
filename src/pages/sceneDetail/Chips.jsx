import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SceneDetailPage.module.css';

const MAX_CHIPS = 8;

// A chip is a hand-off to the listing behind the entity: a performer opens
// their page, a tag or studio opens Scenes filtered to it. Same focusable-chip
// pattern and styling as GalleryChip; `kind` only namespaces the focus id.
function Chip({ kind, item, onSelect }) {
  const { ref, focused } = useFocusable({
    id: `scene-${kind}-${item.id}`,
    zone: 'scene-detail',
    onEnter: () => onSelect(item),
  });

  return (
    <button
      ref={ref}
      className={`${styles.chip} ${styles.chipButton} ${focused ? styles.chipFocused : ''}`}
      onClick={() => onSelect(item)}
    >
      {item.name}
    </button>
  );
}

export function Chips({ items, className, kind = 'tag', onSelect }) {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_CHIPS);
  const extra = items.length - shown.length;
  return (
    <div className={`${styles.chips} ${className || ''}`}>
      {shown.map((item, i) => (
        onSelect
          ? <Chip key={item.id ?? i} kind={kind} item={item} onSelect={onSelect} />
          : <span key={item.id ?? i} className={styles.chip}>{item.name}</span>
      ))}
      {extra > 0 && <span className={styles.chipMore}>+{extra}</span>}
    </div>
  );
}
