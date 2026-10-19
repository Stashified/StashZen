export const SKIP_SECONDS = 15;
export const CONTROLS_HIDE_DELAY = 3000;
export const SKIM_PREVIEW_HIDE_DELAY = 900;

export const RESUME_SAVE_INTERVAL_MS = 30_000; // periodic save during playback
export const RESUME_SKIP_THRESHOLD_S = 10;     // ignore resume if less than this
export const RESUME_END_THRESHOLD_S  = 30;     // ignore resume if within this of end

// A `timeupdate` that moves the clock by more than this did not come from
// playback — it came from a seek: a skim, a marker jump, or the resume seek on
// open. Crediting those would report the distance skipped as time watched, and
// "played a few seconds, skipped around" is exactly the shape that would look
// like a rewatch. The gap between two timeupdate events during playback is well
// under a second at any frame rate a TV negotiates, so 1.5s separates the two
// with room to spare at either end.
export const PLAY_CREDIT_MAX_S = 1.5;
// Below this there is nothing worth a request.
export const PLAY_CREDIT_MIN_S = 1;
