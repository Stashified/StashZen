/**
 * ListStats, the muted count line Stash puts between its toolbar and its
 * cards ("1-40 of 5,834").
 *
 * Narrower than Stash's: this app infinite-scrolls, so there is no page to
 * locate in and only the total is ported. The line answers what the toolbar
 * cannot, how much is behind the current filter/sort/search.
 *
 * Left-aligned with the grid, not centred as in the reference: a centred line
 * under a left-aligned bar reads as a mistake.
 *
 * Returns null rather than "0 of 0": the empty and error states have their own
 * full-page treatment, and a count above "No videos found." is noise.
 */
import styles from './ListStats.module.css';

export default function ListStats({ loaded, total, noun = 'videos' }) {
  if (!loaded || !total) return null;

  // While more pages remain the first number is the on-screen count; once
  // exhausted it equals the total, and "5,834 of 5,834" reads as a bug.
  const text = loaded >= total
    ? `${total.toLocaleString()} ${noun}`
    : `${loaded} of ${total.toLocaleString()} ${noun}`;

  // A test hook, an attribute because CSS-module class names are hashed in the
  // build. It must be *here*: with this line absent, "the first <p> in the
  // page" falls through to a card title and a check passes for the wrong
  // reason. Same convention as `data-focus-trap`.
  return <p className={styles.stats} data-list-stats="">{text}</p>;
}
