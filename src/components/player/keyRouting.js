import { TIZEN_BACK } from '../../utils/input.js';

/**
 * True when a dialog other than the player's own overlay is in the document.
 *
 * The overlay itself carries `role="dialog"`, so this cannot be a simple
 * `querySelector` — it has to exclude ours. Two dialogs can legitimately be
 * open at once with the player: the marker modal and the scene detail page,
 * both of which the player renders inside the overlay. Nested or not, they are
 * distinct elements from the overlay, which is all this test asks.
 *
 * Tested for presence rather than by asking where focus is, so the yield also
 * covers the ~50ms between a dialog mounting and its autoFocus landing. Inside
 * that window a focus-based test would let the player eat the first press and
 * make the new dialog look dead.
 */
export function foreignDialogOpen(ownOverlay) {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (let i = 0; i < dialogs.length; i += 1) {
    if (dialogs[i] !== ownOverlay) return true;
  }
  return false;
}

/**
 * The player's key map, as a pure function of the event and the screen state.
 *
 * The listener in `usePlayerKeys` is then only the side effects: every
 * "preventDefault or not", "stopPropagation or not" and "which action" is
 * decided here, which is what makes the most intricate table in the player
 * testable without a browser.
 *
 * Three states, not two. With the rail up the cursor owns ←/→ and Enter, so
 * those must be left alone (`rail-pass`, and note that even the keys the
 * player does not handle stop short of `stopPropagation` — consuming them is
 * what would break spatial nav and the focused button). Outside the rail,
 * every key the player sees is stopped: the global handler falls back to "any
 * open dialog" when focus is on <body>, which is this overlay, so an
 * unconsumed arrow would drop the cursor onto the rail the user never opened.
 *
 * A foreign dialog (the marker form, the detail page) wins over everything and
 * yields without consuming: this listener runs first in the capture phase, so
 * returning untouched *is* the yield.
 *
 * `controlsVisible` layers Back. Outside the rail, a Back with the bar on
 * screen puts the bar away and the next one closes the player — the user's
 * 2026-10-18 report: "when video is playing and controls are shown, pressing
 * back does first close the control bar before closing video". Inside the rail
 * Back is `leave-rail` either way, which hides the bar as it blurs.
 *
 * Returns `{ action, prevent, stop }`. `action` is one of:
 *   yield, media, step-prev, step-next, leave-rail, hide-controls, close,
 *   reveal-rail, skim-back, skim-forward, rail-pass, none
 */
export function routePlayerKey(
  event,
  { railHoldsFocus, foreignDialog, singleScene, controlsVisible = false },
) {
  const key = event.key;
  const code = event.keyCode;

  if (foreignDialog) return { action: 'yield', prevent: false, stop: false };

  const isBack = key === 'Escape' || key === 'Backspace' || code === TIZEN_BACK;
  const isMedia = key === ' ' || code === 32 || code === 415 || code === 19 || code === 10252;

  if (railHoldsFocus) {
    // Instant transport, in every state. The media keys are the remote's own
    // play/pause button and there is no reason to make them raise a rail
    // first; Space is grouped with them rather than with Enter because Space
    // natively activates a focused <button> on keyup, so leaving it unhandled
    // would fire the focused rail button too.
    if (isMedia) return { action: 'media', prevent: true, stop: true };

    // ↑/↓ step scenes here too, and the stop is load-bearing: without it the
    // rail's own focusable handler would walk the cursor instead, so the key
    // would do two things at once.
    if (key === 'ArrowUp' || code === 38) return { action: 'step-prev', prevent: true, stop: true };
    if (key === 'ArrowDown' || code === 40) return { action: 'step-next', prevent: true, stop: true };

    // Back leaves the rail — "one level up", which is the only thing Back
    // means anywhere else in this app, and since ↑ no longer leaves it, this
    // is now the rail's *only* exit.
    if (isBack) return { action: 'leave-rail', prevent: true, stop: true };

    return { action: 'rail-pass', prevent: false, stop: false };
  }

  // Back is one level up, and the controls bar is a level: it goes first, and
  // the press after that closes the player. 413 is the same key by another
  // code, so it gets the same layering.
  if (isBack || code === 413) {
    return controlsVisible
      ? { action: 'hide-controls', prevent: true, stop: true }
      : { action: 'close', prevent: true, stop: true };
  }

  if (isMedia) return { action: 'media', prevent: true, stop: true };

  // OK is the entry key, so it no longer toggles playback: see the key map at
  // the top of VideoPlayer for why the blank press had to be spent on
  // something.
  if (key === 'Enter' || code === 13) return { action: 'reveal-rail', prevent: true, stop: true };

  if (key === 'ArrowLeft' || code === 37 || code === 412) return { action: 'skim-back', prevent: true, stop: true };
  if (key === 'ArrowRight' || code === 39 || code === 417) return { action: 'skim-forward', prevent: true, stop: true };

  // A one-scene queue has nowhere to step, so ↑/↓ raise the controls instead:
  // the user pressing a direction on a lone video is reaching for the
  // transport, and doing nothing reads as a dropped key.
  if (key === 'ArrowUp' || code === 38) {
    return { action: singleScene ? 'reveal-rail' : 'step-prev', prevent: true, stop: true };
  }
  if (key === 'ArrowDown' || code === 40) {
    return { action: singleScene ? 'reveal-rail' : 'step-next', prevent: true, stop: true };
  }

  return { action: 'none', prevent: false, stop: true };
}
