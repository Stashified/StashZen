import { useState } from 'react';
import { getSettings, setSettings, clearSettings } from '../utils/settings.js';
import { normalizeEndpointUrl } from '../utils/endpointUrl.js';

/**
 * The Settings panel's draft form.
 *
 * Every field is local until `save()` commits it, which is what makes Cancel
 * mean cancel: choosing OLED and backing out must leave the page as it was,
 * not restyle it on the way out. `useMock` is a draft too even though
 * `setSettings` persists it; the store owns how.
 *
 * `clear()` re-reads the store rather than assuming what clearing produced:
 * the store owns the defaults (notably useMock = ENV_MOCK). It does not touch
 * the panel's other state (test results, PIN); the caller decides what else a
 * clear invalidates.
 *
 * `dirty` compares the drafts with the last committed snapshot, not the
 * values this hook was constructed with: after Save the baseline moves, or
 * the panel would keep claiming unsaved work. Text fields are compared
 * trimmed because Save trims them.
 */
const snapshot = (s) => ({
  useMock: !!s.useMock,
  stashUrl: String(s.stashUrl ?? '').trim(),
  stashKey: String(s.stashKey ?? '').trim(),
  previewsEnabled: !!s.previewsEnabled,
  reduceMotion: !!s.reduceMotion,
  seekStep: s.seekStep,
  theme: s.theme,
  playbackEngine: s.playbackEngine,
});

export function useSettingsDraft(initial) {
  const [useMock, setUseMock] = useState(initial.useMock);
  const [stashUrl, setStashUrl] = useState(initial.stashUrl);
  const [stashKey, setStashKey] = useState(initial.stashKey);
  const [previewsEnabled, setPreviewsEnabled] = useState(initial.previewsEnabled);
  const [reduceMotion, setReduceMotion] = useState(initial.reduceMotion);
  const [seekStep, setSeekStep] = useState(initial.seekStep);
  // Appearance is a draft like everything else, see above.
  const [theme, setTheme] = useState(initial.theme);
  // Playback engine is a draft too: choosing Browser and cancelling must not
  // change the next scene the user opens.
  const [playbackEngine, setPlaybackEngine] = useState(initial.playbackEngine);
  // What the store last committed. Initialised from the same object the drafts
  // above are initialised from, so opening the panel is never "dirty".
  const [baseline, setBaseline] = useState(() => snapshot(initial));
  // Why the last Save was refused, if it was. The panel shows it; the store is
  // left untouched.
  const [saveError, setSaveError] = useState(null);

  /** Commit the drafts. Returns false, and keeps the panel open, when the
   *  endpoint cannot be used. The first-run flow tests the connection first;
   *  this is the only check Settings has. */
  const save = () => {
    let url = stashUrl.trim();
    if (!useMock) {
      // Same rule as first-run, so a scheme-less entry is not accepted on one
      // screen and refused on the other.
      const endpoint = normalizeEndpointUrl(url);
      if (!endpoint.ok) {
        setSaveError(endpoint.error);
        return false;
      }
      url = endpoint.url;
    }
    setSaveError(null);
    setSettings({
      useMock,
      // Test mode hides the connection fields, so their drafts may hold a
      // half-typed Live value. Keep what is stored instead of committing it
      // unseen.
      ...(useMock ? {} : { stashUrl: url, stashKey: stashKey.trim() }),
      previewsEnabled,
      reduceMotion,
      seekStep,
      theme,
      playbackEngine,
    });
    // Read back rather than reusing the patch: the store owns normalisation,
    // and in Test mode the connection the patch omitted. The drafts follow,
    // or `dirty` would stay true for fields the user cannot see.
    const saved = getSettings();
    setStashUrl(saved.stashUrl);
    setStashKey(saved.stashKey);
    setBaseline(snapshot(saved));
    return true;
  };

  const clear = () => {
    clearSettings();
    setSaveError(null);
    const fresh = getSettings();
    setUseMock(fresh.useMock);
    setStashUrl(fresh.stashUrl);
    setStashKey(fresh.stashKey);
    setPreviewsEnabled(fresh.previewsEnabled);
    setReduceMotion(fresh.reduceMotion);
    setSeekStep(fresh.seekStep);
    setTheme(fresh.theme);
    setPlaybackEngine(fresh.playbackEngine);
    setBaseline(snapshot(fresh));
  };

  const current = snapshot({
    useMock, stashUrl, stashKey, previewsEnabled, reduceMotion, seekStep,
    theme, playbackEngine,
  });
  const dirty = Object.keys(baseline).some(key => baseline[key] !== current[key]);

  return {
    useMock, setUseMock,
    stashUrl, setStashUrl,
    stashKey, setStashKey,
    previewsEnabled, setPreviewsEnabled,
    reduceMotion, setReduceMotion,
    seekStep, setSeekStep,
    theme, setTheme,
    playbackEngine, setPlaybackEngine,
    dirty,
    saveError,
    save, clear,
  };
}
