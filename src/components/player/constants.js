export const SKIP_SECONDS = 15;
// YouTube's seek ladder: a tap is 5 s, holding climbs 10, 30, 60. A direction
// change or a pause starts again at the first rung.
export const SKIM_STEPS = [5, 10, 30, 60];
// Each rung lasts this long before the next one, as on YouTube.
export const SKIM_RUNG_HOLD_MS = 1000;
// A held remote repeats at ~30 Hz. Throttle those repeats, or the ladder turns
// into minutes per second; discrete taps are never dropped.
export const SKIM_REPEAT_MS = 300;
export const SKIM_ACCEL_RESET_MS = 900;
export const CONTROLS_HIDE_DELAY = 3000;
export const SKIM_PREVIEW_HIDE_DELAY = 900;

export const RESUME_SAVE_INTERVAL_MS = 30_000; // periodic save during playback
export const RESUME_SKIP_THRESHOLD_S = 10;     // ignore resume if less than this
export const RESUME_END_THRESHOLD_S  = 30;     // ignore resume if within this of end

// A `timeupdate` that moves the clock by more than this is a seek, a skim, a
// marker jump or the resume seek, not playback; crediting it would report the
// skipped distance as watch time. Playback ticks are well under 1 s apart.
export const PLAY_CREDIT_MAX_S = 1.5;
// Below this there is nothing worth a request.
export const PLAY_CREDIT_MIN_S = 1;
