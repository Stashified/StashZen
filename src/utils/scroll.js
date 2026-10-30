/**
 * The nearest ancestor the element actually scrolls inside, or null.
 *
 * Geometry treats a scrolled-out row and the fixed footer below it as equally
 * valid, and the nearer footer wins, so Down in a long dialog skips the fold
 * and jumps straight to Save. Actual overflow (scrollHeight > clientHeight) is
 * required so containers with nothing to scroll get no penalty.
 *
 * Shared by the key handler (the container exit penalty) and useFocusable (the
 * top-row reset), which must agree on what container a card scrolls in.
 */
export function scrollContainerOf(el) {
  let n = el?.parentElement;
  while (n && n !== document.body && n !== document.documentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return null;
}
