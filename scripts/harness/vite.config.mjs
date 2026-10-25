/**
 * Lib-mode build for the headless DOM harness.
 *
 * Run from the repo root (or via run.sh): `build.lib.entry` resolves against
 * the Vite root, which defaults to the working directory.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Substitute every build-time constant the app's own vite.config.js does, or a
// driver reaching that code dies on `X is not defined` with no visible cause.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Must live inside the project: a /tmp config resolves node_modules
  // relative to itself and dies with ERR_MODULE_NOT_FOUND.
  plugins: [react()],

  // A lib build does not substitute NODE_ENV, and react-dom reads it at import
  // time — without this the page dies with "process is not defined". It also
  // halves the bundle (production React).
  //
  // `HARNESS_NODE_ENV=development` exposes StrictMode's mount/unmount/remount
  // to prove FirstRun re-arms its latch.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.HARNESS_NODE_ENV || 'production'),
    __APP_VERSION__: JSON.stringify(pkg.version),
    // The build-level rollback, so a driver can prove Browser is today's
    // player. Off unless a driver asks.
    __FORCE_BROWSER_ENGINE__: JSON.stringify(process.env.HARNESS_FORCE_BROWSER === '1'),
  },

  build: {
    lib: {
      // Overridable so one config serves several drivers; run.sh sets both.
      entry: process.env.HARNESS_ENTRY || 'scripts/harness/entry.jsx',
      formats: ['es'],
      fileName: () => 'verify.js',
    },
    cssCodeSplit: false,
    // Outside the repo on purpose — not a build artifact.
    outDir: process.env.HARNESS_OUT || '/tmp/detailverify/dist',
    emptyOutDir: true,
    // Readable stack traces in the failure report.
    minify: false,
  },
});
