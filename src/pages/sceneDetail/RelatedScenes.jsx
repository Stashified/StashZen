import VideoCard from '../../components/VideoCard.jsx';
import styles from '../SceneDetailPage.module.css';

// Two rows at most, four cards each. Pressing one replaces the open scene
// rather than stacking a second detail: the page is keyed on the scene id, so
// App setting `selectedScene` is all it takes.
//
// The cards sit in VideoCard's own `grid` zone, which is what keeps Down from
// the action row and Up from a card crossing zones rather than wandering
// sideways into the chips.
export function RelatedScenes({ rows, onSelect }) {
  if (!rows.length) return null;
  return (
    <div className={styles.related}>
      {rows.map(row => (
        <section key={row.key} className={styles.relatedRow} aria-label={row.label}>
          <span className={styles.relatedLabel}>{row.label}</span>
          <div className={styles.relatedCards}>
            {row.items.map((item, i) => (
              <VideoCard
                key={item.id}
                item={item}
                index={i}
                list={row.items}
                focusIdPrefix={`related-${row.key}`}
                autoFocus={false}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
