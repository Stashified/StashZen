/**
 * Headless driver for the app's last-resort recovery screen.
 *
 * Mounts the real ErrorBoundary around a component that throws during render.
 * On a TV the failure this fixes looks like a black screen with no console, so
 * the assertions are about what a user can actually see and do:
 *
 *   - the error screen replaces the failed tree,
 *   - the failure message is visible (the one diagnostic a TV otherwise has),
 *   - "Try again" takes focus without App's navigator being mounted,
 *   - arrow keys still move between the two actions,
 *   - Restart calls the restart hook,
 *   - a successful retry brings the real tree back.
 *
 * The restart hook is injected rather than letting the component call
 * `location.reload()`: a driver that reloads its own page can never report.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx';
import PlayerErrorBoundary from '../../src/components/PlayerErrorBoundary.jsx';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms = 4000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

let shouldThrow = true;
let restartCalls = 0;

function Bomb() {
  if (shouldThrow) throw new Error('VERIFY render failure');
  return <div id="recovered">recovered</div>;
}

function byText(text) {
  return Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').trim() === text) || null;
}

async function run() {
  const root = createRoot(document.getElementById('root'));
  root.render(
    <ErrorBoundary onRestart={() => { restartCalls += 1; }}>
      <Bomb />
    </ErrorBoundary>,
  );

  const shown = await waitFor(() => !!document.querySelector('[role="alertdialog"]'));
  check('E1 a render error is caught and the recovery screen appears', shown);

  const dialog = document.querySelector('[role="alertdialog"]');
  check('E1 it is announced as an alert dialog',
    dialog?.getAttribute('aria-label') === 'Something went wrong',
    dialog?.getAttribute('aria-label') || 'none');

  const text = dialog?.textContent || '';
  check('E2 the title is visible', text.includes('Something went wrong'), text.slice(0, 80));
  check('E2 the thrown message is visible — the only diagnostic a TV has',
    text.includes('VERIFY render failure'), text.slice(0, 120));

  const retry = byText('Try again');
  const restart = byText('Restart');
  check('E3 both recovery actions rendered', !!retry && !!restart,
    `retry=${!!retry} restart=${!!restart}`);

  // autoFocus is a 50 ms timer inside useFocusable.
  await waitFor(() => document.activeElement === retry, 1500);
  check('E4 Try again owns focus without App being mounted',
    document.activeElement === retry,
    `active=${JSON.stringify(document.activeElement?.textContent || null)}`);

  // The error screen registers its own useKeyHandler. Without it the D-pad is
  // dead here: the tree that owns App's navigator is exactly what unmounted.
  const right = new KeyboardEvent('keydown', {
    key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true,
  });
  document.activeElement?.dispatchEvent(right);
  await waitFor(() => document.activeElement === restart, 1500);
  check('E5 an arrow key moves focus to Restart — navigation is registered',
    document.activeElement === restart,
    `active=${JSON.stringify(document.activeElement?.textContent || null)}`);

  restart?.click();
  await sleep(50);
  check('E6 Restart calls the restart hook', restartCalls === 1, `calls=${restartCalls}`);
  check('E6 Restart does not fake a recovery on its own',
    !!document.querySelector('[role="alertdialog"]') && !document.getElementById('recovered'));

  // The failure was transient: now the child can render.
  shouldThrow = false;
  retry?.click();
  const recovered = await waitFor(() => !!document.getElementById('recovered'), 2000);
  check('E7 Try again re-renders the children', recovered);
  check('E7 the recovery screen is gone', !document.querySelector('[role="alertdialog"]'));

  check('E8 the driver saw no uncaught error escape',
    !window.__escaped, `escaped=${window.__escaped || 0}`);

  // ── The player's own boundary ────────────────────────────
  // The global ErrorBoundary is the last resort and replaces the whole app;
  // for a render failure inside the player that is too much — the session is
  // still good, and the fix is to close the player and keep browsing. This
  // mounts PlayerErrorBoundary where AppOverlays does, around a child that
  // cannot render.
  function PlayerBomb() { throw new Error('VERIFY player failure'); }
  let closeCalls = 0;
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    root.render(
      <PlayerErrorBoundary onClose={() => { closeCalls += 1; }}>
        <PlayerBomb />
      </PlayerErrorBoundary>,
    );
    // The boundary defers the close by CLOSE_DELAY_MS (1600 ms) so the
    // message is readable before the player goes. This wait has to outlast
    // that timer, not just the commit that raises it: waiting 300 ms asserted
    // "closed exactly once" while the close was still pending, which is how
    // these two checks sat red without the fix being wrong.
    await sleep(1900);
  } finally {
    console.error = realError;
  }

  // The app's boundary is told apart by its own sentence, not by "Something
  // went wrong": the player's fallback says that too ("Something went wrong.
  // See the log for details."), so the broader phrase made a correct player
  // boundary fail this check.
  check('P1 a player render error is closed, not turned into the app recovery screen',
    !document.querySelector('[role="alertdialog"]')
      && !document.body.textContent.includes('StashZen hit an unexpected error'),
    `recovery screen: ${!!document.querySelector('[role="alertdialog"]')}, `
      + `player fallback: ${document.body.textContent.includes('Playback stopped')}`);
  check('P1 the player is closed exactly once',
    closeCalls === 1, `${closeCalls} call(s)`);
  check('P1 the failure is logged — the console a TV does not show',
    logged.some(args => String(args[0]).includes('[StashZen] player render error')),
    `${logged.length} console.error call(s)`);
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

window.__escaped = 0;
window.addEventListener('error', () => { window.__escaped += 1; });

run().then(finish).catch(async (e) => {
  check('E9 the driver itself threw', false,
    String(e && e.stack ? e.stack.split('\n')[0] : e));
  await finish();
});
