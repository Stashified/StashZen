/**
 * HeroInfo, the title block above a carousel or a coverflow.
 *
 * The descriptors in `carouselViews.js` decide which fields a section has; this
 * draws them. Shared so a new hero field is added in one place: Carousel and
 * Coverflow used to carry identical markup and stylesheets.
 *
 * `details` is an array of strings on one line. `undefined` means the section
 * has no such field, while an empty array keeps the line's height. `blurb` is
 * the same for the two-line description slot, which only the carousel uses.
 *
 * The counter is always drawn; see the views for what `total` means when the
 * listing does not know it yet.
 */

import styles from './HeroInfo.module.css';

const META_CLASS = {
  tag: styles.heroTag,
  rating: styles.heroRating,
};

export default function HeroInfo({
  title, meta = [], details, blurb, index, total, variant,
}) {
  return (
    <div className={`${styles.hero} ${variant === 'coverflow' ? styles.heroCoverflow : ''}`}>
      <div className={styles.heroText}>
        <h2 className={styles.heroTitle}>{title}</h2>
        <div className={styles.heroMeta}>
          {meta.map((m, i) => (
            <span key={i} className={META_CLASS[m.kind]}>{m.text}</span>
          ))}
        </div>
        {/* One line, ellipsised in CSS; an empty list still holds its height. */}
        {details !== undefined && (
          <div className={styles.heroDetails}>{details?.join(' · ')}</div>
        )}
        {/* Clamped to two lines. The slot keeps the height when a row has no
            description, so focus does not move the strip. */}
        {blurb !== undefined && (
          <div className={styles.infoSlot}>
            {blurb && <p className={styles.heroBlurb}>{blurb}</p>}
          </div>
        )}
      </div>
      <div className={styles.heroCounter}>
        <span className={styles.heroCounterCur}>{index + 1}</span>
        <span className={styles.heroCounterSep}>/</span>
        <span className={styles.heroCounterTotal}>{total}</span>
      </div>
    </div>
  );
}
