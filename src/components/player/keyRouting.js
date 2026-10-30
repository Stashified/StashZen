import { isBackCode } from '../../utils/input.js';

/**
 * True when a dialog other than the player's own overlay is in the document.
 *
 * The overlay carries `role="dialog"` itself, so ours must be excluded. The
 * marker modal and the scene detail page are separate elements rendered inside
 * it. Presence is tested rather than focus, so the yield also covers the ~50 ms
 * before a new dialog's autoFocus lands, a focus test would let the player eat
 * its first press.
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
 * `usePlayerKeys` only performs the result, which makes the most intricate
 * table in the player testable without a browser.
 *
 * Three states, not two. With the rail up the cursor owns ←/→ and Enter, so
 * those pass untouched (`rail-pass`), consuming them would break spatial nav
 * and the focused button. Outside the rail every key is stopped: when focus is
 * on <body> the global handler falls back to "any open dialog", which is this
 * overlay, so an unconsumed arrow would land on a rail the user never opened.
 *
 * A foreign dialog wins and yields without consuming: this listener runs first
 * in the capture phase, so returning untouched *is* the yield.
 *
 * `controlsVisible` layers Back. Outside the rail, a Back with the bar up puts
 * the bar away and the next one closes the player. Inside the rail Back is
 * `leave-rail` either way, which hides the bar as it blurs.
 *
 * Returns `{ action, prevent, stop }`. `action` is one of:
 *   yield, media, step-prev, step-next, leave-rail, leave-rail-seek,
 *   hide-controls, close, reveal-rail, skim-back, skim-forward, rail-pass,
 *   enter-upnext, hide-upnext, none
 *
 * `leave-rail` and `leave-rail-seek` both exit, differing in the bar: Back
 * dismisses it (one level up); ↑ leaves the cursor on a bar that stays up so
 * ←/→ can skim.
 *
 * The vertical keys walk a ladder: on the buttons ↓ steps to the next scene and
 * ↑ goes to the seek bar; on the seek bar ↓ returns to the buttons and ↑ steps
 * to the previous scene. With the bar hidden there is no middle stop, and both
 * step directly.
 *
 * The Up next card (the last 30 s of a scene) adds a stop on top: it takes the
 * cursor when it appears and owns every key while it is visible, because the
 * controls behind it stay down. `upNextFocused` says whether the cursor is
 * already on it: if so ←/→ and Enter are the buttons', if not the first press
 * puts it there (`enter-upnext`). ↓ still steps the scene and Back puts the
 * card away.
 */
export function routePlayerKey(
  event,
  {
    railHoldsFocus, foreignDialog, singleScene, controlsVisible = false,
    upNextVisible = false, upNextFocused = false,
  },
) {
  const key = event.key;
  const code = event.keyCode;

  if (foreignDialog) return { action: 'yield', prevent: false, stop: false };

  const isBack = key === 'Escape' || key === 'Backspace' || isBackCode(code);
  const isMedia = key === ' ' || code === 32 || code === 415 || code === 19 || code === 10252;

  // A held Back is one press: its repeats would otherwise walk the two-stop
  // ladder and close the player from the same hold. Swallowed so it cannot
  // reach the app's Back handler behind it. Arrows and media keys repeat.
  if (isBack && event.repeat) return { action: 'none', prevent: true, stop: true };

  // The card is the only stop while it is up, whatever holds the cursor: it is
  // visible and the controls behind it are not, so a hidden rail must not take
  // a key. That state is reachable, the autofocus is cancelled by a keydown and
  // a skim hold crossing the 30 s boundary is a stream of them.
  if (upNextVisible) {
    if (isMedia) return { action: 'media', prevent: true, stop: true };
    // Back puts it away, the same as Hide, rather than raising the controls
    // behind it. The queue still advances when the scene ends.
    if (isBack) return { action: 'hide-upnext', prevent: true, stop: true };
    // ↓ keeps the rail's meaning.
    if (key === 'ArrowDown' || code === 40) {
      return { action: singleScene ? 'none' : 'step-next', prevent: true, stop: true };
    }
    // ↑ has nowhere to go from the card: raising the seek bar under an offer
    // that already answers the remote is the mess this card exists to replace.
    if (key === 'ArrowUp' || code === 38) {
      return upNextFocused
        ? { action: 'none', prevent: true, stop: true }
        : { action: 'enter-upnext', prevent: true, stop: true };
    }
    // ←/→ walk the two buttons and Enter activates one, both spatial nav. Off
    // the card the first press puts the cursor on Play now instead.
    return upNextFocused
      ? { action: 'rail-pass', prevent: false, stop: false }
      : { action: 'enter-upnext', prevent: true, stop: true };
  }

  if (railHoldsFocus) {
    // Instant transport in every state: the media keys are the remote's own
    // play/pause. Space is grouped here, not with Enter, because it natively
    // activates the focused <button> on keyup.
    if (isMedia) return { action: 'media', prevent: true, stop: true };

    // ↑ leaves the buttons for the seek bar and keeps the bar up, so ←/→ skim
    // a visible timeline. The stop is load-bearing: without it the rail's own
    // focusable handler would walk the cursor.
    if (key === 'ArrowUp' || code === 38) {
      return { action: 'leave-rail-seek', prevent: true, stop: true };
    }
    // ↓ steps to the next scene directly, the buttons are the top stop of the
    // downward ladder. A one-scene queue has nowhere to step, so the press is
    // consumed rather than jumping to play/pause.
    if (key === 'ArrowDown' || code === 40) {
      return { action: singleScene ? 'none' : 'step-next', prevent: true, stop: true };
    }

    // Back leaves the rail as well, "one level up", all Back ever means here.
    if (isBack) return { action: 'leave-rail', prevent: true, stop: true };

    return { action: 'rail-pass', prevent: false, stop: false };
  }

  // Back is one level up, and the controls bar is a level: it goes first, the
  // next press closes the player.
  if (isBack) {
    return controlsVisible
      ? { action: 'hide-controls', prevent: true, stop: true }
      : { action: 'close', prevent: true, stop: true };
  }

  if (isMedia) return { action: 'media', prevent: true, stop: true };

  // OK is the entry key, not a playback toggle: it raises the rail.
  if (key === 'Enter' || code === 13) return { action: 'reveal-rail', prevent: true, stop: true };

  if (key === 'ArrowLeft' || code === 37 || code === 412) return { action: 'skim-back', prevent: true, stop: true };
  if (key === 'ArrowRight' || code === 39 || code === 417) return { action: 'skim-forward', prevent: true, stop: true };

  // Off the buttons, ↑ steps the scene on the seek bar too: the seek bar is the
  // *bottom* stop of the upward ladder. ↓ is buttons when the bar is up and a
  // step when it is hidden. A one-scene queue has nowhere to step, so ↑/↓ raise
  // the controls instead, doing nothing reads as a dropped key.
  if (key === 'ArrowUp' || code === 38) {
    return { action: singleScene ? 'reveal-rail' : 'step-prev', prevent: true, stop: true };
  }
  if (key === 'ArrowDown' || code === 40) {
    if (singleScene) return { action: 'reveal-rail', prevent: true, stop: true };
    return { action: controlsVisible ? 'reveal-rail' : 'step-next', prevent: true, stop: true };
  }

  return { action: 'none', prevent: false, stop: true };
}
