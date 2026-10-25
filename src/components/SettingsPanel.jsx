/**
 * SettingsPanel — full-screen settings modal.
 *
 * Composes the sections in `settings/`; this file is the shell that orders
 * them and owns the drafts, Save and the Back guard. Everything round-trips
 * through localStorage, including Test/Live mode — a mode that reverted on
 * launch made a configured device look unconfigured.
 *
 * Keyboard: Backspace / Esc / Tizen Back closes the modal, except while the
 * PIN keypad is open, which owns those keys itself. That guard is
 * load-bearing, not defensive.
 */

import { useEffect, useRef, useState } from 'react';
import styles from './SettingsPanel.module.css';
import { ActionButton } from './tvActions.jsx';
import UnsavedPrompt from './UnsavedPrompt.jsx';
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

// Long enough to read as "saved, closing", short enough not to feel stalled.
const SAVE_CLOSE_DELAY_MS = 1200;

export default function SettingsPanel({ onClose }) {
  const settings = useSettings();
  // A build-level rollback makes the setting inert, so the row shows the engine
  // in use rather than a lever that cannot move. Compile-time constant, not
  // state.
  const forcedBrowser = readForcedBrowser();

  // Drafts: only committed to the store on Save. See the hook for why every
  // field, appearance included, is a draft.
  const {
    useMock, setUseMock,
    stashUrl, setStashUrl,
    stashKey, setStashKey,
    previewsEnabled, setPreviewsEnabled,
    theme, setTheme,
    playbackEngine, setPlaybackEngine,
    dirty,
    save, clear,
  } = useSettingsDraft(settings);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // A test can take up to the client's 12 s timeout, during which the panel can
  // close or switch to Test mode. Results are keyed to their attempt, so a late
  // answer paints nothing and two presses cannot resolve out of order. Re-armed
  // in the effect body: a cleanup-only latch is false after StrictMode's double
  // mount for the rest of a dev session.
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

  // Set by AppLockSection while its PIN keypad is open. A ref, not state: this
  // component renders nothing different for it; the Back handler only needs to
  // stay out of the way.
  const pinFlowRef = useRef(null);

  // Flipping to Live jumps focus into the URL field; otherwise spatial nav
  // lands on "Save". It focuses the field's *wrapper*, not its input, which
  // would raise the on-screen keyboard before the user asked to type.
  useEffect(() => {
    if (!useMock) {
      // Defer one tick so the field has registered its wrapper.
      const t = setTimeout(() => {
        urlFieldRef.current?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [useMock]);

  // Leaving with unsaved drafts asks first — backing out silently would throw
  // the change away, indistinguishably from a save. The prompt is the only
  // place a discard can happen, and it names the alternative.
  //
  // Back reads the freshest closure through useBackKey's ref, so the flag is
  // never stale.
  const [leavePrompt, setLeavePrompt] = useState(false);
  // Where the cursor was when Back raised the prompt. Restored if the user
  // keeps editing, so dismissing the question does not also move them.
  const returnFocusRef = useRef(null);

  const dismissLeavePrompt = () => {
    setLeavePrompt(false);
    const el = returnFocusRef.current;
    returnFocusRef.current = null;
    el?.focus?.();
  };

  const requestClose = () => {
    // Back while the prompt is open answers "keep editing" rather than
    // re-opening it. The prompt registers no Back handler: this listener runs
    // first, and sibling capture listeners cannot suppress each other — see
    // useSettingsBack.
    if (leavePrompt) {
      dismissLeavePrompt();
      return;
    }
    if (dirty) {
      returnFocusRef.current = document.activeElement;
      setLeavePrompt(true);
      return;
    }
    onClose?.();
  };

  // Trap Back / Esc to close, except while typing (Backspace deletes) or while
  // the PIN keypad owns the keys. See the hook.
  useSettingsBack(requestClose, pinFlowRef);

  useEffect(() => { setTestResult(null); }, [stashUrl, stashKey]);

  const [saved, setSaved] = useState(false);
  // Held in a ref so it can be cleared on unmount — a stale timeout would
  // close a panel reopened within the delay.
  const closeTimerRef = useRef(null);

  // The scrolling body. The footer is a sibling, so moving Down to Save does
  // not scroll it: the last focusable in the body is the PIN button, and the
  // hint below it has no D-pad stop, so it stayed clipped at the fold. The
  // footer is the panel's end, so it brings the body's end with it.
  const bodyRef = useRef(null);
  const revealBodyEnd = () => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  };

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  const handleSave = () => {
    save();
    setSaved(true);
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => onClose?.(), SAVE_CLOSE_DELAY_MS);
  };

  // Save goes through the normal path so the footer reports "Saved ✓" and the
  // usual close timer runs; discard is the only route that drops the drafts.
  const saveAndClose = () => {
    setLeavePrompt(false);
    handleSave();
  };
  const discardAndClose = () => {
    setLeavePrompt(false);
    onClose?.();
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
            <span className={styles.tagline}>Firm grip, steady strokes, and a happy ending in every scene.</span>
          </div>
          <div className={styles.titleRow}>
            <h2 className={styles.title}>Settings</h2>
            <div className={styles.version}>v{__APP_VERSION__}</div>
          </div>
          <p className={styles.subtitle}>Connection, data source &amp; security</p>
        </header>

        <div className={styles.body} ref={bodyRef}>
          <ModeToggle value={useMock} onChange={setUseMock} />

          {/* Unmounted in Test mode, not dimmed: a `.disabled` class leaves the
              fields reachable by D-pad and editable while the hint says they
              are not. The values live in panel state, so Live restores them. */}
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

          {/* Not a duplicate of the fields above: it is the only route back to
              "skip and use sample data", and the only place a connection is
              verified before saving. A flag, not clearing `onboarded`, so Back
              can cancel and return here. */}
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

          {/* A draft like everything here — committed by Save, so backing out
              leaves it as it was. */}
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

          {/* Auto is browser first, TV pipeline for what it cannot take; TV
              player is the A/B lever; Browser is the rollback lever. The hint
              does not promise better quality: the Phase 0 probe measured
              hardware decode on par with the browser for 4K, not better. */}
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

          {/* The hint is the whole ten-foot explanation: what changes, and why
              the cards do not go fully black with the page. */}
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

        <footer className={styles.footer} onFocusCapture={revealBodyEnd}>
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
            onClick={requestClose}
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

      {leavePrompt && (
        <UnsavedPrompt
          onSave={saveAndClose}
          onDiscard={discardAndClose}
          onKeepEditing={dismissLeavePrompt}
        />
      )}
    </div>
  );
}
