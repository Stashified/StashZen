/**
 * FirstRun — connection setup, shown before the app on a fresh device.
 *
 * Shipped builds bake in no credentials and the env fallback is a localhost URL
 * nothing listens on, so without this a fresh .wgt opens on "Cannot reach the
 * Stash server" with no hint that a setting is missing.
 *
 * It gates by rendering the setup screen *instead of* the app, like AppLock,
 * not by drawing over a mounted App: App fetches on mount, so an overlay would
 * load an unreachable library behind an empty panel.
 *
 * Shown when `onboarded` is null (never answered) or `setupRequested` is set.
 * Two separate fields so a re-run can be cancelled — Back returns to the app.
 * On a genuine first run there is nothing behind this, so Back does nothing.
 * The PIN lock stays outside, in main.jsx: a device with a PIN has already been
 * through setup, so the two never compete.
 *
 * ## Two steps, and `onboarded` commits at the end
 *
 * Step one is the connection; step two is an optional PIN, offered only on a
 * genuine first run — otherwise a user who wants a shared TV locked must first
 * get through an unlocked launch to reach Settings.
 *
 * Connect and Skip hold a *pending* patch; the flow commits it once, when the
 * PIN step finishes or immediately when that step is not offered. Abandoning
 * midway commits nothing.
 *
 * The PIN takes effect on the NEXT launch: AppLock reads `isLockSet()` once at
 * mount and does not subscribe (see its header), so a PIN set here cannot cover
 * this screen. Resume re-reads the store after a visibility flip longer than
 * its 1500ms grace.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useEditableField } from '../hooks/useEditableField.js';
import { useKeyHandler } from '../hooks/useKeyHandler.js';
import { useSettings, setSettings, testStashConnection } from '../utils/settings.js';
import { setPin, PIN_LENGTH } from '../utils/appLock.js';
import PinPad from './PinPad.jsx';
import styles from './FirstRun.module.css';

// One zone: no rail or grid to keep apart, so nothing to protect; it exists
// only because useFocusable wants one.
const ZONE = 'setup';

// A LAN address, not `localhost`: on a TV the server is by definition elsewhere
// on the network. Port 9999 is Stash's own example default.
//
// It is only ever the *shape* of an answer, never the answer: neither field is
// prefilled unless a connection has actually been saved.
const URL_PLACEHOLDER = 'http://192.168.1.10:9999';

// ── A text field you select first, then edit ─────────────
// Same interaction as SettingsPanel's, and the same two traps — held in
// useEditableField, where the reasoning lives.
function TextField({ id, label, value, onChange, placeholder, type = 'text', autoFocus = false }) {
  const labelId = `${id}-label`;
  const { setWrapperRef, inputRef, selected, editing, inputHandlers } = useEditableField({
    id,
    zone: ZONE,
    autoFocus,
  });

  return (
    <div
      ref={setWrapperRef}
      className={[
        styles.field,
        selected ? styles.focused : '',
        editing ? styles.editing : '',
      ].join(' ')}
    >
      <span className={styles.fieldLabel} id={labelId}>{label}</span>
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={styles.input}
        tabIndex={-1}
        aria-labelledby={labelId}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...inputHandlers}
      />
      <span className={styles.fieldHint}>
        {editing ? 'Press Enter when done' : 'Press Enter to edit'}
      </span>
    </div>
  );
}

function ActionButton({ id, label, primary, busy, onClick }) {
  const { ref, focused } = useFocusable({ id, zone: ZONE, onEnter: onClick });
  return (
    <button
      ref={ref}
      className={`${styles.actionBtn} ${primary ? styles.actionPrimary : ''} ${focused ? styles.focused : ''}`}
      onClick={onClick}
      disabled={busy}
    >
      {label}
    </button>
  );
}

// ── The optional PIN step ────────────────────────────────
/**
 * Step two: an optional 4-digit PIN, on its own screen.
 *
 * A step rather than a third button because the setup card is already full; a
 * 12-key pad inline would compete for 1080p and nest a focus trap with no room.
 * A step gets its own trap for free: PinPad renders its own `role="dialog"`,
 * and `modalScopeOf` scopes nav to the nearest enclosing one.
 *
 * `onDecline` is required, not a courtesy: Back returns to the connection step
 * and Skip returns here, so without a third way out the two are a cycle. See
 * PinPad's header.
 *
 * The set → confirm → mismatch-restarts machine is lifted from SettingsPanel's
 * AppLockSection; only "done" differs — there it closes a panel, here it
 * commits a settings patch.
 */
function PinStep({ onFinish, onCancel }) {
  const [phase, setPhase] = useState('set');
  const [firstPin, setFirstPin] = useState(null);

  const handleSubmit = (pin) => {
    if (phase === 'set') {
      setFirstPin(pin);
      setPhase('confirm');
      return true;
    }

    // Back to the first phase: if the *first* entry was mistyped,
    // re-confirming against it would loop forever.
    if (pin !== firstPin) {
      setFirstPin(null);
      setPhase('set');
      return 'PINs did not match — start again';
    }

    // setPin reports whether the write landed; never continue (or leave the
    // device locked) on a failed save.
    if (!setPin(pin)) {
      setFirstPin(null);
      setPhase('set');
      return 'Could not save the PIN on this device';
    }

    onFinish();
    return true;
  };

  return (
    <PinPad
      title={phase === 'confirm' ? 'Confirm PIN' : 'Set a PIN'}
      subtitle={phase === 'confirm'
        ? 'Enter the same PIN again'
        : `Optional — a ${PIN_LENGTH}-digit PIN to open StashZen`}
      hint="Press Back to go back, or Not now to skip"
      onSubmit={handleSubmit}
      onCancel={onCancel}
      onDecline={onFinish}
    />
  );
}

// ── The gate ─────────────────────────────────────────────
export default function FirstRun({ children }) {
  const settings = useSettings();
  const active = !settings.onboarded || settings.setupRequested;

  if (!active) return children;
  return <SetupScreen settings={settings} />;
}

function SetupScreen({ settings }) {
  // Prefilled only from a *saved* connection: `stashUrl` is never empty (it
  // falls back to the env default), and a wrong address that looks real means
  // clearing it with an on-screen keyboard first.
  const prefilled = settings.hasSavedEndpoint;

  const [url, setUrl] = useState(prefilled ? settings.stashUrl : '');
  const [key, setKey] = useState(prefilled ? settings.stashKey : '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  // { ok: boolean, message: string } | null

  // ── The two-step flow ───────────────────────────────────
  // `pending` is the settings patch this flow will commit, held rather than
  // applied. It is null until Connect or Skip has succeeded.
  const [pending, setPending] = useState(null);
  const [step, setStep] = useState('connect');

  // A re-run exists to fix a connection and Settings already owns the PIN, so
  // the PIN step is offered only where there was never an answer. This is the
  // complement of `canCancel`: on a first run there is nothing to go back to.
  const isFirstRun = !settings.onboarded;

  // Back is only an exit from a re-run.
  const canCancel = !isFirstRun;

  /**
   * Hold the patch and move on — to the PIN step, or straight to the commit
   * when there is none (so a re-run is one step long).
   */
  const advance = (patch) => {
    if (!isFirstRun) {
      setSettings(patch);
      return;
    }
    setPending(patch);
    setStep('pin');
  };

  // The setup screen replaces <App />, and the global arrow-key navigator lives
  // in App — without this the screen would focus the URL field and ignore the
  // D-pad. Same wiring as LockScreen.
  const handleCancel = useCallback(() => {
    setSettings({ setupRequested: false });
  }, []);

  useKeyHandler({ onBack: canCancel ? handleCancel : undefined });

  // The connect handler resolves *after* a successful commit has replaced this
  // component with the app, so every setState below is guarded (React 18 no
  // longer warns, which is why it needs saying).
  //
  // Re-armed in the effect body, not just at ref creation: StrictMode re-mounts
  // against the *same* ref, so a cleanup-only latch would stay false for the
  // rest of a dev session and Test / Connect would silently stop answering.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Every answer belongs to an attempt. Skip can be pressed while Connect is
  // still testing (Connect disables *itself*, not the screen); without this, a
  // slow Connect landing after Skip would replace the held patch, and the PIN
  // step would commit "connected" for someone who chose not to connect. The
  // newer attempt wins; the older one is dropped.
  const attemptRef = useRef(0);

  const runTest = async () => {
    const attempt = ++attemptRef.current;
    setBusy(true);
    setStatus(null);
    const result = await testStashConnection({ url: url.trim(), key: key.trim() });
    if (!aliveRef.current || attempt !== attemptRef.current) return null;
    setBusy(false);
    return result;
  };

  const handleTest = async () => {
    const result = await runTest();
    if (!result) return;
    setStatus(result.ok
      ? { ok: true, message: `Connected — Stash v${result.version}` }
      : { ok: false, message: result.reason });
  };

  /**
   * Connect tests first rather than saving blind: a wrong URL typed on a remote
   * is the likeliest mistake here, and this screen is where to find out — not
   * an empty grid three taps later. The cost is that a server merely *down*
   * cannot be saved from here; Skip, then Settings, is the way through.
   */
  const handleConnect = async () => {
    const result = await runTest();
    if (!result) return;
    if (!result.ok) {
      setStatus({ ok: false, message: result.reason });
      return;
    }
    advance({
      stashUrl: url.trim(),
      stashKey: key.trim(),
      useMock: false,
      onboarded: 'live',
      setupRequested: false,
    });
  };

  const handleSkip = () => {
    // Skip supersedes anything in flight: bump the attempt so its answer is
    // dropped, and clear the busy state it owns (its resolution no longer
    // will). Otherwise a late Connect calls `advance` and undoes the Skip.
    attemptRef.current++;
    setBusy(false);
    // Does not commit what was typed. "Skip" means "I have not connected";
    // saving an unverified URL would make the next launch fail against it
    // instead of showing sample data.
    advance({ useMock: true, onboarded: 'test', setupRequested: false });
  };

  /**
   * Commit the held patch once the flow is done — the PIN step finished or was
   * declined. A plain closure over `pending`, not a `setPending(p => ...)`
   * updater: updaters must be pure and React may call them twice, so the write
   * would repeat.
   */
  const finish = () => setSettings(pending);

  if (step === 'pin') {
    return <PinStep onFinish={finish} onCancel={() => setStep('connect')} />;
  }

  return (
    <div className={styles.cover}>
      <div className={styles.card} role="dialog" aria-modal="true" aria-label="Connect to Stash">
        <header className={styles.header}>
          {/* The first screen a new user sees, so it is where the product
              names itself; wordmark and tagline are one lockup on purpose. */}
          <div className={styles.brand}>
            <span className={styles.brandName}>StashZen</span>
            <span className={styles.tagline}>Firm grip, steady strokes, and a happy ending in every scene.</span>
          </div>
          <h1 className={styles.title}>Connect to Stash</h1>
          <p className={styles.subtitle}>
            Point StashZen at your Stash server to browse your library. You can
            skip this and look around with sample data instead.
          </p>
        </header>

        <div className={styles.fields}>
          <TextField
            id="firstrun-url"
            label="Stash GraphQL endpoint"
            value={url}
            onChange={setUrl}
            placeholder={URL_PLACEHOLDER}
            autoFocus
          />
          <TextField
            id="firstrun-key"
            label="API key"
            value={key}
            onChange={setKey}
            placeholder="Settings → Security in the Stash web app"
            type="password"
          />
        </div>

        <div className={styles.testRow}>
          <ActionButton
            id="firstrun-test"
            label={busy ? 'Testing…' : 'Test connection'}
            busy={busy}
            onClick={handleTest}
          />
          {status && (
            <span
              className={`${styles.status} ${status.ok ? styles.statusOk : styles.statusFail}`}
              role="status"
              aria-live="polite"
            >
              {status.ok ? '✓' : '✗'} {status.message}
            </span>
          )}
        </div>

        <div className={styles.actions}>
          <ActionButton
            id="firstrun-connect"
            label={busy ? 'Connecting…' : 'Connect'}
            primary
            busy={busy}
            onClick={handleConnect}
          />
          <ActionButton id="firstrun-skip" label="Skip — use sample data" onClick={handleSkip} />
        </div>

        <p className={styles.hint}>
          The endpoint and key are saved on this device only. If your server is
          not reachable yet, skip and set it up later under{' '}
          <strong>Settings → Connection</strong>.
          {/* Announced here: on a first run both buttons lead to the PIN step,
              and an unannounced step reads as something going wrong. */}
          {isFirstRun && <> Next you can set an optional PIN.</>}
          {canCancel && <> Press <strong>Back</strong> to leave setup as it was.</>}
        </p>

        <div className={styles.version}>v{__APP_VERSION__}</div>
      </div>
    </div>
  );
}
