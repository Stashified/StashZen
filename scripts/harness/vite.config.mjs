/**
 * Lib-mode build for the headless DOM harness.
 *
 * Run from the repo root (or via run.sh, which does `cd $(git rev-parse
 * --show-toplevel)` first) — `build.lib.entry` resolves against the Vite
 * root, which defaults to the working directory.
 *
 * The three settings below are all load-bearing; each one cost a debugging
 * round when the harness was first built. See [[headless-dom-harness]].
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Every build-time constant the app's own vite.config.js substitutes has to be
// substituted here too, or a driver that reaches the code reading one dies on
// `X is not defined`. That is not hypothetical: mounting the whole App crashed
// the tree on `__APP_VERSION__`, and the only visible symptom was that the rail
// had vanished — a render error unmounts everything and leaves no trace of what
// threw. `NODE_ENV` below is the same hazard in a different costume.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // This file has to live inside the project. A config in /tmp importing
  // `vite` resolves node_modules relative to its own location and dies with
  // ERR_MODULE_NOT_FOUND.
  plugins: [react()],

  // A lib build does not substitute NODE_ENV the way a normal Vite build
  // does, and react-dom reads it at import time — without this the page dies
  // with "process is not defined" and an empty root. (It also halves the
  // bundle: dev React vs production React.)
  //
  // `HARNESS_NODE_ENV=development` is for the one behaviour that a production
  // build cannot show: StrictMode mounts, tears its effects down and mounts
  // them again, and a latch that is only cleared on cleanup is dead from then
  // on. The sweep stays on production; the firstrun driver is run once more
  // under development to prove FirstRun re-arms its latch.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.HARNESS_NODE_ENV || 'production'),
    __APP_VERSION__: JSON.stringify(pkg.version),
    // The build-level rollback, so a driver can prove Browser is today's
    // player. Off unless a driver asks.
    __FORCE_BROWSER_ENGINE__: JSON.stringify(process.env.HARNESS_FORCE_BROWSER === '1'),
  },

  build: {
    lib: {
      // Overridable so one config can serve several drivers without the
      // second one copying the three load-bearing settings above. run.sh
      // sets both, and defaults them to the detail-page pair.
      entry: process.env.HARNESS_ENTRY || 'scripts/harness/entry.jsx',
      formats: ['es'],
      fileName: () => 'verify.js',
    },
    cssCodeSplit: false,
    // Outside the repo on purpose — the harness is not a build artifact and
    // has no business in dist/.
    outDir: process.env.HARNESS_OUT || '/tmp/detailverify/dist',
    emptyOutDir: true,
    // Readable stack traces in the failure report.
    minify: false,
  },
});
