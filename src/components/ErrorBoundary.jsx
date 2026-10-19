/**
 * ErrorBoundary — keeps one render error from turning the TV black
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * On a TV that is a black screen with no devtools, no reload gesture and no
 * way back except force-quitting the app from the launcher. This wraps the
 * tree (see main.jsx) and, on a render/lifecycle error, swaps in a screen
 * with two focusable actions.
 *
 * Why a class component: `getDerivedStateFromError` has no hook equivalent,
 * and this is the one place the app still needs one.
 *
 * The fallback registers `useKeyHandler({})` itself. Spatial navigation lives
 * in App, which is exactly the tree that has just unmounted — without this
 * the D-pad would be dead on the one screen the user needs it on. This is the
 * same reason LockScreen registers it.
 *
 * Recovery:
 *   - "Try again" clears the error and re-renders the children. If the
 *     failure was transient (a bad response shape, a race), the app comes
 *     back — but React unmounted the failed tree, so every component
 *     remounts with fresh state: the current tab, open overlays and player
 *     position are lost. Saved settings (and module-level state) survive.
 *   - "Restart" reloads the widget, which is the cold start the TV offers no
 *     other way to perform. React state is lost; saved settings are not.
 *
 * Deliberately NOT a global error handler: an unhandled promise rejection
 * from a failed background fetch must not take over the screen. Those are
 * logged in main.jsx; only errors React can attribute to rendering land here.
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
  // Arrow keys only; Back must not dismiss the screen — there is nothing
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
    // A TV has no console, but the harness and desktop dev do, and the
    // component stack is the difference between "it broke" and "this line".
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
