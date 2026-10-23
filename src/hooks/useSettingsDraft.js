import { useState } from 'react';
import { getSettings, setSettings, clearSettings } from '../utils/settings.js';

/**
 * The Settings panel's draft form.
 *
 * Every field is local until `save()` commits it, which is what makes Cancel
 * mean cancel: choosing OLED and backing out must leave the page as it was,
 * not restyle it on the way out. `useMock` is a draft like the rest even
 * though it is not part of the saved object in the same way — `setSettings`
 * persists it, and the store owns how.
 *
 * `clear()` re-reads the store rather than assuming what clearing produced —
 * the store owns the defaults (notably useMock = ENV_MOCK), and guessing here
 * is what previously left the panel disagreeing with the store. It does not
 * touch the panel's other state (test results, PIN and so on); the caller
 * decides what else a clear invalidates.
 */
export function useSettingsDraft(initial) {
  const [useMock, setUseMock] = useState(initial.useMock);
  const [stashUrl, setStashUrl] = useState(initial.stashUrl);
  const [stashKey, setStashKey] = useState(initial.stashKey);
  const [previewsEnabled, setPreviewsEnabled] = useState(initial.previewsEnabled);
  // Appearance is a draft like everything else — see above.
  const [theme, setTheme] = useState(initial.theme);
  // Playback engine is a draft too: choosing Browser and cancelling must not
  // change the next scene the user opens.
  const [playbackEngine, setPlaybackEngine] = useState(initial.playbackEngine);

  const save = () => {
    setSettings({
      useMock,
      stashUrl: stashUrl.trim(),
      stashKey: stashKey.trim(),
      previewsEnabled,
      theme,
      playbackEngine,
    });
  };

  const clear = () => {
    clearSettings();
    const fresh = getSettings();
    setUseMock(fresh.useMock);
    setStashUrl(fresh.stashUrl);
    setStashKey(fresh.stashKey);
    setPreviewsEnabled(fresh.previewsEnabled);
    setTheme(fresh.theme);
    setPlaybackEngine(fresh.playbackEngine);
  };

  return {
    useMock, setUseMock,
    stashUrl, setStashUrl,
    stashKey, setStashKey,
    previewsEnabled, setPreviewsEnabled,
    theme, setTheme,
    playbackEngine, setPlaybackEngine,
    save, clear,
  };
}
