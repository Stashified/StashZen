import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AppLock from './components/AppLock.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import FirstRun from './components/FirstRun.jsx';
import './index.css';

// Register Tizen TV remote keys (no-op in browser dev)
if (typeof window !== 'undefined' && window.tizen?.tvinputdevice) {
  try {
    const keys = [
      'MediaPlay', 'MediaPause', 'MediaPlayPause',
      'MediaStop', 'MediaRewind', 'MediaFastForward',
      'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
    ];
    keys.forEach(k => {
      try {
        window.tizen.tvinputdevice.registerKey(k);
      } catch (e) {
        // This device lacks that key; the app still receives the ones it has,
        // and handlers treat a missing media key as "not pressed".
      }
    });
  } catch (e) {
    console.warn('Tizen key registration failed:', e);
  }
}

// Last-resort logging for failures React cannot attribute to a render. These
// must NOT take over the screen (one failed thumbnail must not hide the
// library), but without them the TV's only symptom is a silent nothing.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[StashZen] unhandled promise rejection:', e.reason);
  });
  window.addEventListener('error', (e) => {
    console.error('[StashZen] uncaught error:', e.error || e.message);
  });
}

// AppLock wraps App rather than sitting inside it: while locked, App is
// unmounted, so nothing behind the PIN is fetched or focusable. FirstRun sits
// inside AppLock for the same reason one level down — with no server there is
// no library to show, so App is not mounted rather than mounted and hidden.
// A PIN can only be set from a running app, so the two gates cannot both want
// the screen. ErrorBoundary wraps all of it: a throw in either gate would
// blank the screen just as thoroughly, and retrying from the top is the only
// recovery independent of which subtree failed.
ReactDOM.createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <AppLock>
        <FirstRun>
          <App />
        </FirstRun>
      </AppLock>
    </ErrorBoundary>
  </StrictMode>
);
