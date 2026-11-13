import { SEEK_STEP_OPTIONS } from '../../utils/settings.js';
import OptionToggle from './OptionToggle.jsx';

export function SeekStepToggle({ value, onChange }) {
  return (
    <OptionToggle
      label="Seek step"
      idPrefix="settings-seek"
      options={SEEK_STEP_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
