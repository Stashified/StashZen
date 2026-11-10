/**
 * The built-in key guide.
 *
 * A nested dialog like the changelog viewer: Settings yields Back through the
 * ref it passes in. The content is fixed, so this section has no status and no
 * request; it is the README's key tables, on the TV.
 */

import { useState } from 'react';
import { ActionButton } from '../tvActions.jsx';
import { useRestoreFocus } from '../../hooks/useRestoreFocus.js';
import { RemoteHelpOverlay } from './RemoteHelpOverlay.jsx';
import styles from '../SettingsPanel.module.css';

export function RemoteHelpSection({ helpOpenRef }) {
  const [open, setOpen] = useState(false);
  const { remember, restore } = useRestoreFocus();

  // Set synchronously, not in an effect: Settings' capture listener runs on
  // the same keydown as this dialog's, and must see the flag already true.
  const openHelp = () => {
    const active = document.activeElement;
    if (active && active !== document.body) remember(active);
    if (helpOpenRef) helpOpenRef.current = true;
    setOpen(true);
  };
  const closeHelp = () => {
    if (helpOpenRef) helpOpenRef.current = false;
    setOpen(false);
    restore();
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionRow}>
        <div className={styles.sectionText}>
          <span className={styles.fieldLabel}>Remote help</span>
          <p className={styles.sectionStatus}>
            Keys for browsing, the player and the image viewer.
          </p>
        </div>
        <div className={styles.sectionActions}>
          <ActionButton
            id="settings-help"
            label="Open guide"
            onClick={openHelp}
          />
        </div>
      </div>

      <p className={styles.hint}>
        Long-press, Back and the player keys all have a job. The guide opens
        here on the TV; Back closes it and returns to Settings.
      </p>

      {open && <RemoteHelpOverlay onClose={closeHelp} />}
    </div>
  );
}
