import { TRANSCODE_QUALITY_OPTIONS } from '../../utils/settings.js';
import OptionToggle from './OptionToggle.jsx';

export function TranscodeQualityToggle({ value, onChange }) {
  return (
    <OptionToggle
      label="Transcode quality"
      idPrefix="settings-quality"
      options={TRANSCODE_QUALITY_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
