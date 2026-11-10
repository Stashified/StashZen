import { useBackKey } from './useBackKey.js';

/**
 * Settings' Back contract: close the panel, except while a nested dialog owns
 * Back: the PIN keypad, the changelog viewer, or the remote guide.
 *
 * All of them register capture-phase listeners on `window`, and
 * `stopPropagation()` does not suppress a sibling listener on the same target
 * (only `stopImmediatePropagation` would), without the guards the first
 * Backspace would close the whole panel. The guards are refs because the
 * handler is registered once.
 *
 * The text-field rule is `useBackKey`'s default, see `isBackKey`.
 */
export function useSettingsBack(onClose, ...guards) {
  useBackKey(() => {
    if (guards.some(guard => guard?.current)) return;
    onClose?.();
  });
}
