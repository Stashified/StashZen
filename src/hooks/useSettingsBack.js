import { useBackKey } from './useBackKey.js';

/**
 * Settings' Back contract: close the panel — except while the PIN keypad is
 * open, which owns Backspace/Esc/Back itself.
 *
 * Both this and PinPad register capture-phase listeners on `window`, and
 * `stopPropagation()` does not suppress a sibling listener on the same target
 * (only `stopImmediatePropagation` would) — without the guard the first
 * Backspace would close the whole panel. `pinFlowRef` is read through a ref
 * because the handler is registered once.
 *
 * The text-field rule is `useBackKey`'s default — see `isBackKey`.
 */
export function useSettingsBack(onClose, pinFlowRef) {
  useBackKey(() => {
    if (pinFlowRef.current) return;
    onClose?.();
  });
}
