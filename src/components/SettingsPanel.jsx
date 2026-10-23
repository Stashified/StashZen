/**
 * SettingsPanel — Full-screen settings modal
 *
 * Opens from the hamburger menu. Shows:
 *   - Test (mock) / Live mode switch
 *   - When Live: Stash URL + API key text fields (persisted)
 *   - Connection setup: reopen the first-run screen
 *   - App lock: set / change / remove an optional PIN
 *   - Save / Close actions
 *
 * Everything here round-trips through localStorage via the settings store,
 * including the Test/Live mode. (This comment used to say the mode was
 * in-memory and reset to Test on cold load. That was true, and it was the bug
 * 0.8.0 removed: flipping to Live and back on the next launch silently
 * reverted, so a configured device looked unconfigured.)
 *
 * The sections it composes live in `settings/`; this file is the shell that
 * orders them and owns the drafts, Save and the Back guard.
 *
 * Keyboard: Backspace / Esc / Tizen Back closes the modal — except while
 * the PIN keypad is open, which owns those keys itself. See the guard on
 * the handler below; it is load-bearing, not defensive.
 */

import { useEffect, useRef, useState } from 'react';
import styles from './SettingsPanel.module.css';
import { ActionButton } from './tvActions.jsx';
import { useSettings, setSettings, testStashConnection } from '../utils/settings.js';
import { ModeToggle } from './settings/ModeToggle.jsx';
import { ThemeToggle } from './settings/ThemeToggle.jsx';
import { EngineToggle } from './settings/EngineToggle.jsx';
import { TextField } from './settings/TextField.jsx';
import { AppLockSection } from './settings/AppLockSection.jsx';
import { LibraryStatsSection } from './settings/LibraryStatsSection.jsx';
import { ServerStatusSection } from './settings/ServerStatusSection.jsx';
import { useArmedConfirm } from '../hooks/useArmedConfirm.js';
import { useSettingsDraft } from '../hooks/useSettingsDraft.js';
import { useSettingsBack } from '../hooks/useSettingsBack.js';
import { readForcedBrowser } from './player/usePlayerEngine.js';

// Short enough to read as "saved, closing" rather than the 5.6s of dead
// air this used to sit through with no feedback at all.
const SAVE_CLOSE_DELAY_MS = 1200;

// ── Main component ───────────────────────────────────────
export default function SettingsPanel({ onClose }) {
  const settings = useSettings();
  // The build-level rollback makes the setting inert, so the row shows the
  // engine in use rather than a lever that cannot move. A compile-time
  // constant, so it is not state.
  const forcedBrowser = readForcedBrowser();

  // Local draft state — only commits to the store on Save. See the hook for
  // why every field, appearance included, is a draft.
  const {
    useMock, setUseMock,
    stashUrl, setStashUrl,
    stashKey, setStashKey,
    previewsEnabled, setPreviewsEnabled,
    theme, setTheme,
    playbackEngine, setPlaybackEngine,
    save, clear,
  } = useSettingsDraft(settings);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // A test can take up to the client's 12 s timeout, and the panel can close
  // or switch to Test mode in that window. Results are keyed to the attempt
  // that asked for them: a late answer must not paint a status line for a
  // question nobody is looking at any more, and two presses must not resolve
  // out of order. Re-armed in the effect body for the StrictMode double mount
  // — a cleanup-only latch is false for the rest of a dev session.
  const aliveRef = useRef(true);
  const testAttemptRef = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Test mode has no server to test against, and the fields it would test are
  // unmounted. Drop any in-flight answer and the result it would have painted.
  useEffect(() => {
    if (!useMock) return;
    testAttemptRef.current++;
    setTesting(false);
    setTestResult(null);
  }, [useMock]);

  const [confirmingClear, runClear] = useArmedConfirm();
  // testResult shape: { ok: boolean, message: string } | null

  const handleClear = () => {
    runClear(() => {
      clear();
      setTestResult(null);
    });
  };

  const urlFieldRef = useRef(null);

  // Set by AppLockSection while its PIN keypad is open. Declared here
  // rather than lifted into this component's state because nothing here
  // renders differently for it — the handler below only needs to know
  // whether to stay out of the way.
  const pinFlowRef = useRef(null);

  // When the user flips to Live, jump focus straight into the URL
  // field. Otherwise spatial nav from the toggle drops focus on the
  // nearest element below, which is "Save" — a confusing landing.
  //
  // This focuses the field's *wrapper*, not its input: focusing the input
  // would raise the on-screen keyboard before the user asked to type.
  useEffect(() => {
    if (!useMock) {
      // Defer one tick so the field has mounted and registered its wrapper
      // before the focus call lands.
      const t = setTimeout(() => {
        urlFieldRef.current?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [useMock]);

  // Trap Back / Esc to close — except when the user is typing in
  // a text field, where Backspace should delete a character normally, and
  // while the PIN keypad is open. See the hook.
  useSettingsBack(onClose, pinFlowRef);

  useEffect(() => { setTestResult(null); }, [stashUrl, stashKey]);

  const [saved, setSaved] = useState(false);
  // Held in a ref so it can be cleared on unmount. Previously the timer
  // was fire-and-forget: saving and then reopening the panel within the
  // delay let the stale timeout close the *newly opened* panel.
  const closeTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  const handleSave = () => {
    save();
    setSaved(true);
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => onClose?.(), SAVE_CLOSE_DELAY_MS);
  };


  const handleTest = async () => {
    const attempt = ++testAttemptRef.current;
    setTesting(true);
    setTestResult(null);
    const result = await testStashConnection({
      url: stashUrl.trim(),
      key: stashKey.trim(),
    });
    if (!aliveRef.current || attempt !== testAttemptRef.current) return;
    setTesting(false);
    if (result.ok) {
      setTestResult({ ok: true, message: `Connected — Stash v${result.version}` });
    } else {
      setTestResult({ ok: false, message: result.reason });
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-label="Settings" aria-modal="true">
      <div className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.brandName}>StashZen</span>
            <span className={styles.tagline}>Private media, made simple.</span>
          </div>
          <div className={styles.titleRow}>
            <h2 className={styles.title}>Settings</h2>
            <div className={styles.version}>v{__APP_VERSION__}</div>
          </div>
          <p className={styles.subtitle}>Connection, data source &amp; security</p>
        </header>

        <div className={styles.body}>
          <ModeToggle value={useMock} onChange={setUseMock} />

          {/* Live-mode fields. Unmounted in Test mode rather than dimmed:
              the previous version only added a `.disabled` class, so the
              D-pad could still land on the endpoint and key, Enter still
              raised the TV keyboard and the values could still be edited —
              while the visible hint said they were not editable. The values
              themselves live in panel state, so toggling back to Live
              restores them. */}
          <div className={styles.liveFields}>
            {!useMock && (
              <>
                <TextField
                  id="settings-url"
                  label="Stash GraphQL Endpoint"
                  value={stashUrl}
                  onChange={setStashUrl}
                  placeholder="http://localhost:9999"
                  externalRef={urlFieldRef}
                />
                <TextField
                  id="settings-key"
                  label="API Key"
                  value={stashKey}
                  onChange={setStashKey}
                  placeholder="(optional)"
                  type="password"
                />
                <div className={styles.testRow}>
                  <ActionButton
                    id="settings-test"
                    label={testing ? 'Testing…' : 'Test connection'}
                    onClick={handleTest}
                  />
                  {testResult && (
                    <span className={`${styles.testResult} ${testResult.ok ? styles.testOk : styles.testFail}`}>
                      {testResult.ok ? '✓' : '✗'} {testResult.message}
                    </span>
                  )}
                </div>
              </>
            )}
            {useMock && (
              <p className={styles.hint}>
                Switch to <strong>Live</strong> to edit connection settings.
              </p>
            )}
            {!useMock && (
              <p className={styles.hint}>
                Endpoint &amp; key are saved to this device.
              </p>
            )}
            <p className={styles.hint}>
              The mode is saved too — the app opens in whichever one you left it in.
            </p>
          </div>

          {/* Re-runs the first-run screen. Not a convenience duplicate of the
              fields above: it is the only route back to the "skip and use
              sample data" choice, and the only place a connection is verified
              before it is saved. It sets a flag rather than clearing
              `onboarded`, so Back can cancel the re-run and return here. */}
          <div className={styles.section}>
            <div className={styles.sectionRow}>
              <div className={styles.sectionText}>
                <span className={styles.fieldLabel}>Connection setup</span>
                <p className={styles.sectionStatus}>
                  {settings.onboarded === 'live'
                    ? `Connected to ${settings.stashUrl || 'a saved server'}`
                    : settings.onboarded === 'test'
                      ? 'Using sample data.'
                      : 'Not answered on this device yet.'}
                </p>
              </div>
              <div className={styles.sectionActions}>
                <ActionButton
                  id="settings-setup"
                  label="Run setup again"
                  onClick={() => setSettings({ setupRequested: true })}
                />
              </div>
            </div>

            <p className={styles.hint}>
              Reopens the first-run screen, starting from the saved values.
              Back leaves it without changing anything. Clearing saved settings
              below also resets setup, so the screen comes back on next launch.
            </p>
          </div>

          {/* Playback preferences. A draft like everything else in this panel —
              committed by Save, so backing out leaves it as it was. */}
          <div className={styles.section}>
            <div className={styles.sectionRow}>
              <div className={styles.sectionText}>
                <span className={styles.fieldLabel}>Focus previews</span>
                <p className={styles.sectionStatus}>
                  {previewsEnabled
                    ? 'A focused card plays a preview clip where Stash has one.'
                    : 'Cards show their cover only.'}
                </p>
              </div>
              <div className={styles.sectionActions}>
                <ActionButton
                  id="settings-previews"
                  label={previewsEnabled ? 'On' : 'Off'}
                  pressed={previewsEnabled}
                  onClick={() => setPreviewsEnabled(v => !v)}
                />
              </div>
            </div>

            <p className={styles.hint}>
              Previews are generated in Stash, not here —{' '}
              <strong>Generate → Previews</strong>. Scenes without one keep
              their cover; nothing is left blank.
            </p>
          </div>

          {/* Playback engine. Auto is the browser first with the TV's own
              pipeline for what the browser cannot take; TV player is the A/B
              lever; Browser is exactly the previous player and the rollback
              lever. The hint deliberately does not promise better picture
              quality: the Phase 0 probe measured hardware decode on par with
              the browser for 4K, not better. */}
          <div className={styles.section}>
            <EngineToggle
              value={playbackEngine}
              onChange={setPlaybackEngine}
              forcedBrowser={forcedBrowser}
            />
            <p className={styles.hint}>
              {forcedBrowser
                ? 'This build always uses the browser player.'
                : (
                  <>
                    <strong>Auto</strong> plays through the browser first and
                    switches to the TV&apos;s own player for files the browser
                    cannot take. <strong>TV player</strong> puts the TV engine
                    first. <strong>Browser</strong> is the compatibility mode.
                    The change applies the next time a scene is opened.
                  </>
                )}
            </p>
          </div>

          {/* Appearance. The hint is the whole explanation a user needs at
              ten feet: what changes, and why the cards do not go fully black
              with the page. */}
          <div className={styles.section}>
            <ThemeToggle value={theme} onChange={setTheme} />
            <p className={styles.hint}>
              OLED turns the page black for deeper blacks and lower power use.
              Cards stay slightly lifted so their shapes remain visible.
            </p>
          </div>

          <LibraryStatsSection />

          <ServerStatusSection />

          <AppLockSection pinFlowRef={pinFlowRef} />
        </div>

        <footer className={styles.footer}>
          <ActionButton
            id="settings-clear"
            label={confirmingClear ? 'Press again to confirm' : 'Clear saved'}
            onClick={handleClear}
            zone="settings-footer"
          />
          
          <div className={styles.footerSpacer} />
          <ActionButton
            id="settings-cancel"
            label="Cancel"
            onClick={onClose}
            zone="settings-footer"
          />
          <ActionButton
            id="settings-save"
            label={saved ? 'Saved ✓' : 'Save'}
            onClick={handleSave}
            primary
            zone="settings-footer"
          />
        </footer>
      </div>
      
    </div>
  );
}
