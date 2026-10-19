/**
 * ESLint — flat config (ESLint 10)
 *
 * Scope is deliberately narrow: catch bugs, not style. There is no
 * Prettier here and no stylistic rule set, so `npm run lint` stays
 * readable instead of producing a wall of formatting noise.
 *
 * On react-hooks: this project does NOT use the React Compiler, so the
 * compiler-assumption rule family that ships enabled in
 * `react-hooks` v7's recommended set (`purity`, `set-state-in-effect`,
 * `refs`, `immutability`, `static-components`, …) is left off. Those
 * rules assume you're writing compiler-shaped components, and this
 * codebase deliberately isn't — it mutates module-level focus state and
 * sets state from effects in several places. Enabling them turns a
 * first lint run into hundreds of findings nobody will act on. The two
 * classic rules are the ones that catch real defects here: a
 * conditional hook call, or a stale closure from a missing dep.
 */

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // `tizen-studio/**` is not our code. The CI workflow unpacks the ~1.5 GB
  // Tizen Studio SDK into $GITHUB_WORKSPACE — it has to live there for the
  // actions/cache step and for the `tizen` CLI's own relative paths — and
  // the SDK ships sample projects, templates and a jQuery doc bundle that
  // are vanilla ES5 with ~2100 lint errors of their own. Without this
  // entry `eslint .` walks them and the Lint step fails on files nobody
  // here owns.
  //
  // This is worth a comment because the failure is invisible locally: a
  // dev machine has no tizen-studio/ tree, so `npm run lint` passes and
  // only CI goes red.
  { ignores: ['dist/**', 'node_modules/**', 'build/**', 'tizen-studio/**'] },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        // Injected by Vite's `define` (see vite.config.js).
        __APP_VERSION__: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Unused args that are intentionally positional (or dropped during
      // a refactor) shouldn't force a rename-to-underscore ritual — but
      // an unused local is usually a real leftover.
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],

      // Every empty catch in this codebase is the same deliberate shape:
      // assigning `currentTime` on a media element that isn't seekable
      // yet, or registering a Tizen key the device may not have. Both
      // throw routinely and neither is an error worth surfacing. The rule
      // stays on for empty blocks that aren't catches, where an empty
      // body is much more likely to be an oversight.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Build/tooling config files run in Node, not the browser.
  {
    files: ['*.config.js', 'vite.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Dev scripts (`scripts/gen-filter-schema.mjs`, `scripts/verify-filters.mjs`)
  // run under Node: console, process and the global fetch. They are outside the
  // `**/*.{js,jsx}` block above — it doesn't match `.mjs`, which is exactly why
  // `import.meta.env` can be read as undefined there, as filterTranslate.js
  // expects — so without this entry every `console.log` in them is a no-undef.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
