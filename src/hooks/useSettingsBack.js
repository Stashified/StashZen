import { useBackKey } from './useBackKey.js';

/**
 * Settings' Back contract: close the panel — except while the PIN keypad is
 * open, which owns Backspace/Esc/Back itself.
 *
 * This is not defensive coding — it is the only thing that makes the nested
 * keypad usable. Both this listener and PinPad's are capture-phase listeners
 * on `window`, and both are therefore run in the same dispatch step;
 * `stopPropagation()` in PinPad's handler does NOT suppress a sibling
 * listener on the same target (only `stopImmediatePropagation` would). So
 * without this, the first Backspace on the keypad would close the whole
 * settings panel.
 *
 * Read through a ref: the handler is registered once, so a captured
 * `pinFlow` would be stale.
 *
 * The text-field rule (Backspace belongs to the field, Escape and the
 * hardware Back do not) is `useBackKey`'s default — see `isBackKey`.
 */
export function useSettingsBack(onClose, pinFlowRef) {
  useBackKey(() => {
    if (pinFlowRef.current) return;
    onClose?.();
  });
}
