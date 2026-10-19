/**
 * The JS half of the compatibility floor check.
 *
 * The project's normal `npm run lint` answers "is this code correct?"; this
 * config answers "does this code run on the oldest TV the manifest allows?".
 * It layers eslint-plugin-compat over the same base config so the ordinary
 * rules still apply — running it against a separate, thinner config would let
 * a compat-clean file fail normal lint unnoticed.
 *
 * Chrome 94 is the engine behind Tizen 6.5; see scripts/compat-floor.mjs.
 */
import compat from 'eslint-plugin-compat';
import base from './eslint.config.mjs';
import { COMPAT_TARGET } from './scripts/compat-floor.mjs';

export default [
  ...base,
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { compat },
    settings: {
      browsers: [COMPAT_TARGET],
      // Without this the plugin only knows the APIs it has a caniuse record
      // for; ES built-ins such as String.padStart would slip through.
      lintAllEsApis: true,
    },
    rules: { 'compat/compat': 'error' },
  },
];
