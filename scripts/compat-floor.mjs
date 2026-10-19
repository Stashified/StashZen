/**
 * The oldest engine StashZen supports, in one place for both halves of
 * `npm run check:compat`.
 *
 * Tizen 6.5 ships Chromium 94 and is the first Tizen generation the static
 * checks come back clean on. Tizen 6.0 (Chromium 76) already fails on flex
 * `gap` (Chromium 84) and `aspect-ratio` (88); 5.5 (69) fails earlier still.
 * That measurement is why `tizen/config.xml` declares `required_version="6.5"`
 * — if this constant changes, the manifest and the README change with it.
 */
export const COMPAT_TARGET = 'chrome 94';
export const COMPAT_LABEL = 'Tizen 6.5 (Chromium 94)';

/**
 * The same floor in the syntax esbuild and Vite's `build.target` expect.
 * They take `chrome94` with no space; doiuse and eslint-plugin-compat take
 * `chrome 94`. Derived, so the two can never disagree.
 */
export const COMPAT_BUILD_TARGET = COMPAT_TARGET.replace(/\s+/g, '');

/**
 * Features doiuse still reports at the floor but that are not real blockers.
 * Both are already handled where they are used: the media overlays carry the
 * `-webkit-mask` fallback, and `scrollbar-width` is decoration that only
 * changes how the scrollbar looks. Everything else is expected to be clean,
 * so a new entry here means a deliberate decision, not a silenced warning.
 */
export const COMPAT_CSS_IGNORES = ['css-masks', 'css-scrollbar'];
