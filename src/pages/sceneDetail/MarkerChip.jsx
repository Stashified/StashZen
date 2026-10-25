import { useFocusable } from '../../hooks/useFocusable.js';
import { formatTime } from '../../utils/format.js';
import styles from '../SceneDetailPage.module.css';

// A jump target: Enter opens the player at this marker through the same
// queue-of-one path as Play. Not autofocus — Play is the landing spot, and the
// chips are an optional row above the actions.
export function MarkerChip({ marker, onPlayAt }) {
  const { ref, focused } = useFocusable({
    id: `scene-marker-${marker.id}`,
    zone: 'scene-detail',
    onEnter: () => onPlayAt?.(marker.seconds),
  });
  return (
    <button
      ref={ref}
      className={`${styles.markerChip} ${focused ? styles.markerFocused : ''}`}
      onClick={() => onPlayAt?.(marker.seconds)}
      aria-label={`Play from ${formatTime(marker.seconds, { padMinutes: true })} — ${marker.title}`}
    >
      <span className={styles.markerTime}>{formatTime(marker.seconds, { padMinutes: true })}</span>
      <span className={styles.markerName}>{marker.title}</span>
      {marker.tag && marker.tag !== marker.title && (
        <span className={styles.markerTag}>{marker.tag}</span>
      )}
    </button>
  );
}
