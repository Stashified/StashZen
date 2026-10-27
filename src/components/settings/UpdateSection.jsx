/**
 * The public build's update check.
 *
 * Only rendered when the gate is armed (SettingsPanel decides); the check is
 * independent of Stash mode, so it works on sample data too. The toggle applies
 * at once, outside the panel's draft-and-Save flow: a user who flips it and
 * closes the panel still expects the choice to stick.
 *
 * Owns the hook rather than receiving it, so a harness or test that mounts
 * SettingsPanel alone gets a working section. The request itself is shared with
 * App's instance through the module-level in-flight promise in the hook.
 */

import { ActionButton } from '../tvActions.jsx';
import { useSettings, setSettings } from '../../utils/settings.js';
import { useAutoUpdateCheck } from '../../hooks/useAutoUpdateCheck.js';
import styles from '../SettingsPanel.module.css';

function statusText({ phase, availableVersion, latest, lastAt, error }) {
  if (phase === 'checking') return 'Checking for updates…';
  if (availableVersion) return `v${availableVersion} is available.`;
  if (phase === 'error') {
    return error ? `Couldn't check for updates. ${error}` : "Couldn't check for updates.";
  }
  // A success always stores the tag, so a stored timestamp without one means
  // every attempt so far failed. No fourth persisted field needed.
  if (latest) return 'Up to date.';
  if (lastAt > 0) return "Couldn't check for updates last time. Try again.";
  return 'Not checked yet.';
}

export function UpdateSection() {
  const settings = useSettings();
  const updateCheck = useAutoUpdateCheck(settings);
  const enabled = !!settings.updateCheckEnabled;

  return (
    <div className={`${styles.section} ${styles.sectionFirst}`}>
      <div className={styles.sectionRow}>
        <div className={styles.sectionText}>
          <span className={styles.fieldLabel}>Updates</span>
          <p className={styles.sectionStatus} role="status" aria-live="polite">
            {statusText({
              phase: updateCheck.phase,
              availableVersion: updateCheck.availableVersion,
              latest: settings.updateLatestVersion,
              lastAt: settings.lastUpdateCheckAt,
              error: updateCheck.error,
            })}
          </p>
        </div>
        <div className={styles.sectionActions}>
          <ActionButton
            id="settings-update-toggle"
            label={enabled ? 'On' : 'Off'}
            pressed={enabled}
            onClick={() => setSettings({ updateCheckEnabled: !enabled })}
          />
          <ActionButton
            id="settings-update-check"
            label={updateCheck.phase === 'checking' ? 'Checking…' : 'Check now'}
            onClick={updateCheck.checkNow}
          />
        </div>
      </div>

      <p className={styles.hint}>
        On, the app checks once a day while it is open. Updates are installed
        from the GitHub release page; the check sends nothing about this device.
        The toggle applies immediately, not on Save.
      </p>
    </div>
  );
}
