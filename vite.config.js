import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs';
import { COMPAT_BUILD_TARGET } from './scripts/compat-floor.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  plugins: [react()],
  base: './',                     // ← critical: relative paths for Tizen
  build: {
    outDir: 'dist',
    // The declared install floor, in esbuild's syntax: Tizen 6.5 /
    // Chromium 94. One constant lives in scripts/compat-floor.mjs; the
    // manifest and the static checks use the same measurement. Down-levelling
    // below it only inflates the bundle — and config.xml refuses to install
    // on those sets anyway.
    target: COMPAT_BUILD_TARGET,
    assetsInlineLimit: 0,         // don't inline assets
    cssCodeSplit: true,

    // CSS is minified by Lightning CSS (the Vite 8 default; Vite 4 used
    // esbuild). Two behaviours are worth knowing before editing any
    // *.module.css here, because both are silent — no warning, no error,
    // just different bytes in dist/:
    //
    // 1. `cssTarget` is unset, so it inherits the build target above and
    //    Vite maps that to a browser era. Lightning CSS then lowers only
    //    what that engine might need, so the target also decides the CSS
    //    bytes: at `es2015` it shipped `inset:` as four longhands and
    //    added `-webkit-input-placeholder`, `-webkit-filter`,
    //    `-webkit-user-select` and `-webkit-sticky`; at Chromium 94 it
    //    keeps the shorthand and emits none of those (90.85 → 88.05 kB).
    //    That is correct for the declared floor; lowering it again would
    //    also mean lowering config.xml, which refuses to install there.
    //
    // 2. It collapses a standard + vendor-prefixed duplicate PAIR down to
    //    whichever declaration comes LAST. Targets don't enter into it —
    //    even declaring `cssTarget: 'chrome 56'` won't re-add a prefix.
    //    No such pair is declared today (the prefixes the app uses, such
    //    as `-webkit-line-clamp` and `-webkit-box`, have no standard twin
    //    that Lightning CSS would insert), but adding one in the "wrong"
    //    order would silently change what goes to the TV.
    //
    //    A property declared twice in one rule is usually collapsed to the
    //    last value as well — but not always: if the earlier declaration
    //    contains a `var()`, Lightning CSS keeps it in the output. So it is
    //    not a substitute for deleting superseded declarations yourself.
    //
    // Setting `cssMinify: 'esbuild'` restores Vite 4's output (both
    // declarations kept) at the cost of re-adding esbuild's vendor-prefix
    // handling, which is a larger change than it looks.
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})