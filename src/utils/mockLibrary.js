/**
 * mockLibrary.js — the catalogue Test mode pretends to have.
 *
 * A fictional archive: forty-eight restored shorts, six studios, sixty-odd
 * people, markers named the way an editor names them. Every name was invented
 * for this file — ordinary English, no real title, studio or person.
 *
 * Kept in one module so the three generators agree: a marker names the scene
 * it belongs to, and a scene's id means the same thing everywhere. Covers are
 * drawn from these ids in mockArt.js.
 */

export const SCENE_TITLES = [
  'Harbour Lights', 'The Salt Road', 'Paper Lanterns', 'Northern Drift',
  'A Quiet Machine', 'The Long Meadow', 'Copper Sundown', 'Winter Kite',
  'The Glasshouse', 'Slow Tide', 'Cardamom', 'The Cartographer',
  'Blue Hour', 'Tin Roof', 'Sea Glass', 'The Understudy',
  'Amber Line', 'Field Notes', 'The Night Ferry', 'Small Mercies',
  'Ash & Lime', 'The Lamplighter', 'Cold Front', 'Riverbend',
  'The Third Act', 'Marram Grass', 'High Water', 'The Bell Foundry',
  'Painted Doors', 'Wintering', 'The Last Reel', 'Foxglove',
  'Bright Interval', 'The Quiet Hours', 'Saltmarsh', 'Under Canvas',
  'The Orchard Keeper', 'Nightjar', 'Held Light', 'The Turning Year',
  'Stonecrop', 'First Frost', 'The Waiting Room', 'Paper Boats',
  'The Far Field', 'Golden Hour', 'The Kite Maker', 'After the Rain',
];

/** Studios, shown as the card's category badge and used by the Classic
 *  grid's mode filter. */
export const STUDIOS = [
  'Meridian Archive', 'Northlight', 'Saltbox Films',
  'Tidewater Pictures', 'Lantern House', 'Quiet Harbour',
];

/** The two halves of a marker's name. Twelve by five is exactly sixty —
 *  enough for the sixty markers Test mode generates with no repeats, and
 *  every combination of them reads like an editor's note. */
export const MARKER_PREFIXES = [
  'Cold', 'Slow', 'Wide', 'Tight', 'Soft', 'Hard',
  'Early', 'Late', 'First', 'Last', 'Quiet', 'Loud',
];
export const MARKER_SUFFIXES = ['open', 'turn', 'light', 'cut', 'take'];

export const MARKER_TAGS = [
  'Establishing', 'Transition', 'Insert', 'Reaction',
  'Montage', 'Handheld', 'Steadicam', 'Close-up',
];

/** Tags, named the way this archive would name them: production vocabulary
 *  rather than keywords, so a tag grid reads like the rest of Test mode. */
export const TAG_NAMES = [
  'Afternoon Light', 'Anamorphic', 'Archive Print', 'Available Light',
  'Black and White', 'Boom in Frame', 'Close Focus', 'Colour Grade',
  'Continuity Error', 'Crane Shot', 'Day for Night', 'Deep Focus',
  'Double Exposure', 'Dutch Angle', 'First Take', 'Handheld',
  'Hard Light', 'High Key', 'Jump Cut', 'Key Light',
  'Long Lens', 'Long Take', 'Low Key', 'Matte Painting',
  'Model Shot', 'Montage', 'Natural Sound', 'Negative Space',
  'Off Camera', 'On Location', 'Overhead', 'Practical Light',
  'Process Shot', 'Rack Focus', 'Rehearsal', 'Rim Light',
  'Silent', 'Slow Motion', 'Soft Light', 'Split Screen',
  'Steadicam', 'Stock Footage', 'Studio Floor', 'Time Lapse',
  'Tracking Shot', 'Two Shot', 'Wide Lens', 'Whip Pan',
];

/** Galleries, named the way an archive files them — a drawer, an envelope, a
 *  roll — rather than "Gallery 1". Images borrow their gallery's name for
 *  their own title, so these are the only fictional nouns the two need. */
export const GALLERY_TITLES = [
  'Archive Box 3', 'Blue Folder', 'Cardboard Tube', 'Contact Sheet 12',
  'Darkroom Notes', 'Duplicate Prints', 'Envelope 41', 'Field Album',
  'Glassine Sleeves', 'Green Binder', 'Grey Box', 'Harbour Set',
  'Index Cards', 'Loose Prints', 'Meridian Set', 'Negative File A',
  'Northlight Set', 'Old Envelopes', 'Paper Wallet', 'Print Box',
  'Quiet Harbour Set', 'Reference Prints', 'Roll 07', 'Saltbox Set',
  'Second Drawer', 'Sleeve 12', 'Studio Proofs', 'Summer Binder',
  'The Drawer', 'Tidewater Set', 'Unfiled', 'Working Prints',
];

export const FIRST_NAMES = [
  'Ava', 'Mia', 'Iris', 'Nova', 'Zoe', 'Maya', 'Eva', 'Lila', 'Aria', 'Stella',
  'Nina', 'Rosa', 'Ines', 'Talia', 'Wren', 'Juno', 'Cleo', 'Sana', 'Marta', 'Elin',
];

export const LAST_NAMES = [
  'Kane', 'Wells', 'Cross', 'North', 'Vale', 'Reyes', 'Quinn', 'Hart', 'Stone', 'Frost',
  'Lane', 'Park', 'Ashby', 'Merrick', 'Osei', 'Dunn', 'Sato', 'Bright', 'Holloway', 'Carr',
];

export const COUNTRIES = ['US', 'UK', 'DE', 'FR', 'BR', 'JP'];

export const BIOS = [
  'Came to the archive from repertory theatre, and still reads every script out loud before saying yes.',
  'Trained as a dancer; brings a sense of timing to a scene that a stopwatch could not teach.',
  'Known for understated work and a long-running argument with the idea of a lead role.',
  'Started on the other side of the camera, in the cutting room, and never lost the habit.',
  null, null,   // some performers have no bio, and the detail view has to cope
];

/**
 * The scene a generated marker belongs to. Ids match the ones
 * `generateMockVideos` hands out, so "open the parent scene" resolves to a
 * scene that exists and is named the same thing in both places.
 */
export function mockSceneRef(i) {
  const index = i % SCENE_TITLES.length;
  return { id: `vid-${index + 1}`, title: SCENE_TITLES[index] };
}

/** A distinct name for the i-th performer: twenty first names crossed with
 *  twenty last names, walked so sixty people get sixty different names. */
export function mockPersonName(i) {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_NAMES[(i * 7 + Math.floor(i / FIRST_NAMES.length)) % LAST_NAMES.length];
  return `${first} ${last}`;
}
