/**
 * ListStats — the muted count line Stash puts between its toolbar and its
 * cards ("1-40 of 5,834").
 *
 * Its job here is narrower than Stash's. Stash prints it because a desktop
 * paginates, so "1-40" locates you in a page sequence; this app infinite-
 * scrolls and has no page to be located in — its `usePagedList` keeps
 * appending until the listing is exhausted. So only the *total* half is
 * ported, and the line answers the one question the toolbar cannot: how much
 * is behind the filter/sort/search you are looking at.
 *
 * Left-aligned with the grid rather than centred as in the reference. The
 * reference centres it because it centres its whole toolbar; this app's bar is
 * left-aligned, and a centred line under a left-aligned bar reads as a
 * mistake. (Centring the bar itself was measured and rejected — see the note
 * in ControlsPanel.)
 *
 * Returns null rather than "0 of 0": the empty and error states have their own
 * full-page treatment in each grid, and a count line above "No videos found."
 * is noise.
 */
import styles from './ListStats.module.css';

export default function ListStats({ loaded, total, noun = 'videos' }) {
  if (!loaded || !total) return null;

  // While more pages remain the first number is "how many are on screen"; once
  // the listing is exhausted that number is the total and saying it twice
  // ("5,834 of 5,834") is the sort of thing that reads as a bug.
  const text = loaded >= total
    ? `${total.toLocaleString()} ${noun}`
    : `${loaded} of ${total.toLocaleString()} ${noun}`;

  // `data-list-stats` is a test hook, and it is an attribute rather than a
  // class because CSS-module class names are hashed in the build — the harness
  // cannot name one. It also has to be *here* rather than "the first <p> in the
  // page": with this line absent that selector falls through to the first
  // card's title, so a check written that way reads the wrong element and
  // passes for the wrong reason. Same convention as `data-focus-trap`. A
  // control experiment is what surfaced that.
  return <p className={styles.stats} data-list-stats="">{text}</p>;
}
