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
        // This device does not expose that key. The app still receives the
        // ones it does support, and each handler already treats a missing
        // media key as "not pressed" — nothing else to do.
      }
    });
  } catch (e) {
    console.warn('Tizen key registration failed:', e);
  }
}

// Last-resort logging for failures React cannot attribute to a render — a
// rejected background fetch, a listener that throws. These must NOT take over
// the screen (one failed thumbnail should not hide the library), but without
// them a TV's only symptom is a feature that quietly does nothing.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[StashZen] unhandled promise rejection:', e.reason);
  });
  window.addEventListener('error', (e) => {
    console.error('[StashZen] uncaught error:', e.error || e.message);
  });
}

// AppLock wraps App rather than sitting inside it: while locked, App is
// unmounted entirely, so nothing behind the PIN is fetched or focusable.
//
// FirstRun sits inside AppLock and outside App for the same reason one level
// down: until the device knows where its server is, there is no library to
// show, so the app is not mounted at all rather than mounted and then hidden.
// Order matters only in that a PIN is necessarily set from inside a running
// app, so a device that has one has already been through setup — the two
// gates cannot both want the screen.
//
// ErrorBoundary sits outside all of it: a throw in AppLock or FirstRun would
// otherwise blank the screen just as thoroughly as one in App, and retrying
// from the top is the only recovery that does not depend on which subtree
// failed. Errors outside React (promise rejections) are logged, not trapped —
// see the handlers above.
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
