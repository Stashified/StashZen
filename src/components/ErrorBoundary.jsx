/**
 * ErrorBoundary, keeps one render error from turning the TV black.
 *
 * React unmounts the whole tree on an uncaught render throw, which on a TV
 * means no devtools and no way out but force-quitting; this wraps it (main.jsx)
 * and swaps in a screen with two focusable actions.
 *
 * A class because `getDerivedStateFromError` has no hook equivalent. The
 * fallback registers `useKeyHandler({})` itself: spatial navigation lives in
 * App, the tree that just unmounted, so otherwise the D-pad would be dead on
 * the one screen needing it.
 *
 * Recovery: "Try again" remounts the failed tree fresh, losing tab, overlays
 * and player position (saved settings and module-level state survive).
 * "Restart" reloads the widget, the only cold start available; React state is
 * lost, saved settings are not.
 *
 * NOT a global error handler: an unhandled background-fetch rejection must not
 * take over the screen. Those are logged in main.jsx.
 */

import { Component } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useKeyHandler } from '../hooks/useKeyHandler.js';
import styles from './ErrorBoundary.module.css';

function ErrorButton({ id, label, primary, onClick, autoFocus }) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'error-recovery',
    onEnter: onClick,
    autoFocus,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.button} ${primary ? styles.primary : ''} ${focused ? styles.focused : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ErrorScreen({ error, onRetry, onRestart }) {
  // Arrow keys only; Back must not dismiss the screen, there is nothing
  // behind it to go back to.
  useKeyHandler({});

  return (
    <div className={styles.cover} role="alertdialog" aria-modal="true" aria-label="Something went wrong">
      <div className={styles.panel}>
        <h1 className={styles.title}>Something went wrong</h1>
        <p className={styles.subtitle}>
          StashZen hit an unexpected error. Your library and settings are safe.
        </p>
        {error?.message && <p className={styles.detail}>{String(error.message)}</p>}
        <div className={styles.actions}>
          <ErrorButton id="error-retry" label="Try again" primary onClick={onRetry} autoFocus />
          <ErrorButton id="error-restart" label="Restart" onClick={onRestart} />
        </div>
        <p className={styles.hint}>
          If this keeps happening, restart the app. Reporting what you were
          doing when it appeared helps.
        </p>
      </div>
    </div>
  );
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleRestart = this.handleRestart.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // A TV has no console, but the harness and desktop dev do; the component
    // stack is the difference between "it broke" and "this line".
    console.error('[StashZen] render error:', error, info?.componentStack || '');
  }

  handleRetry() {
    this.setState({ error: null });
  }

  handleRestart() {
    if (this.props.onRestart) {
      this.props.onRestart();
      return;
    }
    try {
      window.location.reload();
    } catch (e) {
      // A widget host that forbids reload still gets the retry path rather
      // than a dead button.
      console.warn('[StashZen] location.reload failed:', e);
      this.handleRetry();
    }
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorScreen
          error={this.state.error}
          onRetry={this.handleRetry}
          onRestart={this.handleRestart}
        />
      );
    }
    return this.props.children;
  }
}
