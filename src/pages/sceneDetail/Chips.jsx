import styles from '../SceneDetailPage.module.css';

const MAX_CHIPS = 8;

// ── Chips ───────────────────────────────────────────────────
export function Chips({ items, className }) {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_CHIPS);
  const extra = items.length - shown.length;
  return (
    <div className={`${styles.chips} ${className || ''}`}>
      {shown.map((item, i) => (
        <span key={item.id ?? i} className={styles.chip}>{item.name}</span>
      ))}
      {extra > 0 && <span className={styles.chipMore}>+{extra}</span>}
    </div>
  );
}
