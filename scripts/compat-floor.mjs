/**
 * The oldest engine StashZen supports, shared by both halves of
 * `npm run check:compat`.
 *
 * Tizen 6.5 ships Chromium 94 and is the first generation the static checks
 * pass on. Tizen 6.0 (Chromium 76) fails on flex `gap` (84) and `aspect-ratio`
 * (88); 5.5 (69) fails earlier. `tizen/config.xml` declares
 * `required_version="6.5"`; if this constant changes, the manifest and README
 * change with it.
 */
export const COMPAT_TARGET = 'chrome 94';
export const COMPAT_LABEL = 'Tizen 6.5 (Chromium 94)';

/**
 * The same floor in the syntax esbuild and Vite's `build.target` expect
 * (`chrome94`; doiuse and eslint-plugin-compat take `chrome 94`). Derived, so
 * the two can never disagree.
 */
export const COMPAT_BUILD_TARGET = COMPAT_TARGET.replace(/\s+/g, '');

/**
 * Features doiuse reports at the floor that are not real blockers: the media
 * overlays carry the `-webkit-mask` fallback, and `scrollbar-width` only affects
 * scrollbar appearance. Everything else must be clean, so a new entry is a
 * deliberate decision, not a silenced warning.
 */
export const COMPAT_CSS_IGNORES = ['css-masks', 'css-scrollbar'];
