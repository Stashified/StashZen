/**
 * ConnectionBanner: the one place that says the Stash server is unreachable.
 *
 * Rendered above the page when the shared connection state is down. The Retry
 * button owns focus when it appears: on a TV the cursor is usually somewhere
 * deep in a grid, and a banner whose only action takes ten Up presses is no
 * better than the error text it replaces.
 */

import { useFocusable } from '../hooks/useFocusable.js';
import styles from './ConnectionBanner.module.css';

export default function ConnectionBanner({ message, busy, error, onRetry }) {
  const { ref, focused } = useFocusable({
    id: 'connection-retry',
    zone: 'connection',
    autoFocus: true,
    onEnter: onRetry,
  });

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.dot} aria-hidden="true" />
      <div className={styles.text}>
        <strong className={styles.title}>Cannot reach the Stash server</strong>
        <span className={styles.detail}>{message}</span>
        {error && <span className={styles.error}>{error}</span>}
      </div>
      <button
        ref={ref}
        type="button"
        className={`${styles.retry} ${focused ? styles.retryFocused : ''}`}
        onClick={onRetry}
        aria-busy={busy ? 'true' : undefined}
      >
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
