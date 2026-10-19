/**
 * FirstRun — the connection setup screen, shown before the app on a fresh device
 *
 * Why this exists at all: the shipped build bakes in no credentials (CI sets no
 * VITE_* — see the release workflow), and the env fallback is a localhost URL
 * that nothing is listening on. So until now a freshly installed .wgt opened
 * straight onto "Cannot reach the Stash server" with no hint that a setting was
 * missing, let alone where it was. The first thing a new user saw was a failure.
 *
 * It gates by *rendering the setup screen instead of* the app, the way AppLock
 * does — not by drawing over a mounted App. Same reasoning as there: App fetches
 * on mount, so an overlay would load a library nobody can reach, behind a panel
 * that has not been filled in yet.
 *
 * Shown when the device has never answered the question (`onboarded` is null)
 * or when Settings asked for it again (`setupRequested`). The two are separate
 * fields rather than one nullable flag so a *re-run* can be cancelled — Back
 * returns to the app the user was in. On a genuine first run there is nothing
 * behind this to go back to, so Back deliberately does nothing.
 *
 * The PIN lock stays outside this, in main.jsx. A device with a PIN set has
 * necessarily been through setup already, so the two never compete for the
 * screen.
 *
 * ── Since 0.12.0: two steps, and `onboarded` commits at the end ──────────
 *
 * Step one is the connection; step two is an optional PIN, offered only on a
 * genuine first run. It is asked for here because this screen is already the
 * "answer a few questions" moment, and today a PIN can only be set from
 * Settings — reachable only once the app is open — so a user who wants the app
 * locked, which is the whole point of a shared TV, has to get through an
 * unlocked launch first.
 *
 * **The structural cost, and why this is not a third button on the first
 * screen.** Connect and Skip used to commit on the spot, which closed the gate
 * and mounted the app. They now hold a *pending* patch, and the flow commits it
 * once — when the PIN step finishes, or immediately when that step is not
 * offered. Abandoning midway therefore commits nothing and setup returns, which
 * is the correct outcome and the one a fresh device has today.
 *
 * The PIN takes effect on the NEXT launch, not this one, and that is by
 * construction rather than by luck: AppLock reads `isLockSet()` once at mount
 * and deliberately does not subscribe to the lock store (see its header), so a
 * PIN set here cannot cover the screen the user is standing in. The one path
 * that could still bite is resume — AppLock re-reads the store after a
 * visibility flip longer than its 1500ms grace — and that is a TV-pass item,
 * because a TV's IME is what the harness cannot observe.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useEditableField } from '../hooks/useEditableField.js';
import { useKeyHandler } from '../hooks/useKeyHandler.js';
import { useSettings, setSettings, testStashConnection } from '../utils/settings.js';
import { setPin, PIN_LENGTH } from '../utils/appLock.js';
import PinPad from './PinPad.jsx';
import styles from './FirstRun.module.css';

// Everything on this screen is one zone. There is no rail and no grid to keep
// apart from, so the zone has nothing to protect; it exists only because
// useFocusable wants one.
const ZONE = 'setup';

// A LAN address, not `localhost`: this is the placeholder on a TV, where the
// server is by definition somewhere else on the network. The port is Stash's
// own default — 9999, the one Stash's example config uses.
//
// History worth keeping, because both halves have been got wrong here. The
// address was `http://localhost:9999` in an earlier version, and that is what
// made every fresh install look broken: it was the *default* the app fell
// through to, not an example. It was then changed to a LAN address on the
// wrong port, 8087, which is what this Stash instance happens to listen on and
// so is exactly the kind of local detail that should not be in a placeholder.
// Neither mistake is reachable from here: neither field starts filled in
// unless a connection has actually been saved, so this text is never the
// answer — it is only ever the shape of one.
const URL_PLACEHOLDER = 'http://192.168.1.10:9999';

// ── A text field you select first, then edit ─────────────
// The same interaction as SettingsPanel's, and the same two traps — both held
// in useEditableField, which is where the reasoning lives.
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
 * **Why a step and not a third button on the first screen.** The setup card is
 * already carrying two fields, a test row, two actions, a hint and the version.
 * A 12-key pad rendered inline would compete for 1080p inside a card that is not
 * laid out for one, and would nest a focus trap where there is no room for it.
 * A step gets its own space and its own trap, and the trap comes free: PinPad
 * renders its own `role="dialog"`, and `modalScopeOf` scopes nav to the nearest
 * enclosing one.
 *
 * **`onDecline` is required here, not a courtesy.** Back returns to the
 * connection step and the connection step's Skip returns here, so without a
 * third way out the two steps are a cycle with no exit. See PinPad's header.
 *
 * The set → confirm → mismatch-restarts-at-phase-one machine is lifted from
 * SettingsPanel's AppLockSection — the same argument P1 made for tvActions.jsx:
 * it should not be written out twice. The one difference is what "done" means:
 * there it closes a panel, here it commits a settings patch.
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

    // A mismatch returns to the first phase rather than staying here: if the
    // user mistyped the *first* entry, re-confirming against it would loop
    // forever. Same reasoning, and the same wording, as the settings section.
    if (pin !== firstPin) {
      setFirstPin(null);
      setPhase('set');
      return 'PINs did not match — start again';
    }

    // setPin reports whether the write actually landed. Don't let the flow
    // continue, and don't let the device come up locked, on a failed save.
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
  // Prefilled only from a *saved* connection. `settings.stashUrl` is never
  // empty — it falls back to the env default — and prefilling a localhost
  // placeholder would hand the user a wrong address that looks like a real
  // one, which on a TV means clearing it with an on-screen keyboard first.
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

  // A re-run exists to fix a connection, and Settings already owns the PIN — so
  // the PIN step is offered only where there was never an answer at all. Note
  // this is the *complement* of `canCancel` rather than a coincidence: on a
  // first run there is nothing behind this screen to go back to.
  const isFirstRun = !settings.onboarded;

  // Back is only an exit from a re-run.
  const canCancel = !isFirstRun;

  /**
   * Hold the patch, and move on — either to the PIN step or, when there isn't
   * one, straight to the commit.
   *
   * The two branches look asymmetric and are not: on a re-run there is no PIN
   * step to move to, so the flow is one step long and ends here.
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
  // in App — so without this the screen would render, focus the URL field, and
  // then ignore the D-pad entirely. Same wiring, and the same reason, as
  // LockScreen.
  const handleCancel = useCallback(() => {
    setSettings({ setupRequested: false });
  }, []);

  useKeyHandler({ onBack: canCancel ? handleCancel : undefined });

  // The connect handler resolves *after* a successful commit has replaced this
  // component with the app, so every setState below is guarded. React 18 does
  // not warn about this any more, which is exactly why it needs saying.
  //
  // Re-armed in the effect body, not just at ref creation: StrictMode mounts,
  // tears the first effect down and mounts it again against the *same* ref, so
  // a cleanup-only latch stays false for the rest of a dev session and Test /
  // Connect silently stop answering. The production build does not double-run
  // effects, but the harness proves the latch rather than assuming that.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Every answer belongs to an attempt. Skip can be pressed while Connect is
  // still testing (Connect disables *itself*, not the screen), and the late
  // answer must not be allowed to overwrite the choice the user made after it.
  // Without the token, a slow Connect that lands after Skip replaces the held
  // patch with the live one — the PIN step's finish then commits "connected"
  // for someone who explicitly chose not to connect. Connect after a Test has
  // the same shape: the newer attempt wins, the older one is dropped.
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
   * Connect tests first rather than saving blind.
   *
   * A wrong URL typed on a remote is the likeliest thing to happen here, and
   * the place to find out is this screen — not an empty grid three taps later.
   * The cost of the choice is that a server which is merely *down* cannot be
   * saved from here; Skip, then Settings, is the way through that, and the
   * failure note below says so.
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
    // Skip supersedes anything still in flight: bump the attempt so its answer
    // is dropped, and clear the busy state it owns (its own resolution will no
    // longer do that). Otherwise a Connect that resolves after this press
    // calls `advance` with the live patch and quietly undoes the Skip.
    attemptRef.current++;
    setBusy(false);
    // Deliberately does not commit what was typed. "Skip" means "I have not
    // connected"; saving an unverified URL here would make the next launch
    // fail against it instead of showing sample data.
    advance({ useMock: true, onboarded: 'test', setupRequested: false });
  };

  /**
   * Commit the patch the flow has been holding. Called when it is done —
   * either the PIN step finished, or it was declined.
   *
   * A plain closure over `pending` rather than a `setPending(p => ...)` reader:
   * an updater is expected to be pure and React may call it twice, so committing
   * the settings from inside one would be a write the second call repeats.
   */
  const finish = () => setSettings(pending);

  if (step === 'pin') {
    return <PinStep onFinish={finish} onCancel={() => setStep('connect')} />;
  }

  return (
    <div className={styles.cover}>
      <div className={styles.card} role="dialog" aria-modal="true" aria-label="Connect to Stash">
        <header className={styles.header}>
          {/* The one screen a new user sees before the app, so it is where the
              product names itself. The wordmark and the tagline are one lockup
              deliberately: a tagline that only ever appears in the README is a
              README tagline rather than the project's. */}
          <div className={styles.brand}>
            <span className={styles.brandName}>StashZen</span>
            <span className={styles.tagline}>Private media, made simple.</span>
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
          {/* Said here rather than discovered on the next screen: both of
              these buttons lead to the PIN step on a first run, and a step
              that appears unannounced reads as something going wrong. */}
          {isFirstRun && <> Next you can set an optional PIN.</>}
          {canCancel && <> Press <strong>Back</strong> to leave setup as it was.</>}
        </p>

        <div className={styles.version}>v{__APP_VERSION__}</div>
      </div>
    </div>
  );
}
