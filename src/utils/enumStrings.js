/**
 * Stash's saved filters store enum criteria as the web UI's display strings
 * ("Female", "1080p"), while GraphQL takes enum member names (FEMALE,
 * FULL_HD). The app stores member names; convert at both boundaries.
 */

const SAVED_BY_ENUM = {
  GenderCriterionInput: {
    FEMALE: 'Female',
    INTERSEX: 'Intersex',
    MALE: 'Male',
    NON_BINARY: 'Non-Binary',
    TRANSGENDER_FEMALE: 'Transgender Female',
    TRANSGENDER_MALE: 'Transgender Male',
  },
  // Stash's resolution map is case-sensitive: "4k", not "4K".
  ResolutionCriterionInput: {
    VERY_LOW: '144p',
    LOW: '240p',
    R360P: '360p',
    STANDARD: '480p',
    WEB_HD: '540p',
    STANDARD_HD: '720p',
    FULL_HD: '1080p',
    QUAD_HD: '1440p',
    FOUR_K: '4k',
    FIVE_K: '5k',
    SIX_K: '6k',
    SEVEN_K: '7k',
    EIGHT_K: '8k',
    HUGE: 'Huge',
  },
  CircumcisionCriterionInput: { CUT: 'Cut', UNCUT: 'Uncut' },
};

const ENUM_BY_SAVED = Object.fromEntries(
  Object.entries(SAVED_BY_ENUM).map(([type, map]) => [
    type,
    Object.fromEntries(Object.entries(map).map(([enumValue, saved]) => [saved, enumValue])),
  ]),
);

/** Enum member name → the string Stash's web UI persists. */
export function savedEnumValue(typeName, value) {
  return SAVED_BY_ENUM[typeName]?.[value] ?? value;
}

/** Stash's persisted string → enum member name. Unknown values pass through. */
export function requestEnumValue(typeName, value) {
  return ENUM_BY_SAVED[typeName]?.[value] ?? value;
}

/** The display label for an enum member name. */
export const enumLabel = savedEnumValue;
