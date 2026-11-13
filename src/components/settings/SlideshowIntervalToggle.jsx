import { SLIDESHOW_INTERVAL_OPTIONS } from '../../utils/settings.js';
import OptionToggle from './OptionToggle.jsx';

export function SlideshowIntervalToggle({ value, onChange }) {
  return (
    <OptionToggle
      label="Slideshow interval"
      idPrefix="settings-slideshow"
      options={SLIDESHOW_INTERVAL_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
