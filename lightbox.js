/* Screenshot viewer — no dependencies, no build step.
 *
 * Progressive enhancement: every screenshot is a plain link to the full PNG,
 * so the page works untouched without this file. With JavaScript, a click
 * opens the image in an overlay instead. Modified clicks (new tab, download)
 * are left alone.
 */
(() => {
  const box = document.getElementById('lightbox');
  const image = document.getElementById('lightbox-img');
  const caption = document.getElementById('lightbox-caption');
  const closeButton = box.querySelector('.lightbox-close');
  const prevButton = box.querySelector('.lightbox-prev');
  const nextButton = box.querySelector('.lightbox-next');
  const shots = Array.from(document.querySelectorAll('.shot-grid .shot'));

  if (!shots.length) return;

  let index = 0;
  let returnFocus = null;

  function open(at, moveFocus = true) {
    index = (at + shots.length) % shots.length;
    const link = shots[index];
    const source = link.querySelector('img');
    const figure = link.closest('figure');
    image.src = link.getAttribute('href');
    image.alt = source ? source.alt : '';
    caption.textContent = figure.querySelector('figcaption')?.textContent ?? '';
    const wasOpen = !box.hidden;
    box.hidden = false;
    document.body.classList.add('lightbox-open');
    // Only pull focus into the dialog on open; prev/next keep it on the
    // button the user is already operating.
    if (moveFocus && !wasOpen) closeButton.focus();
  }

  function close() {
    box.hidden = true;
    document.body.classList.remove('lightbox-open');
    if (returnFocus) returnFocus.focus();
  }

  shots.forEach((link, at) => {
    link.addEventListener('click', (event) => {
      // Let the browser open the PNG in a new tab when the user asks for it.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      returnFocus = link;
      open(at);
    });
  });

  closeButton.addEventListener('click', close);
  prevButton.addEventListener('click', () => open(index - 1, false));
  nextButton.addEventListener('click', () => open(index + 1, false));

  // A click on the backdrop (not on the figure or a button) closes.
  box.addEventListener('click', (event) => {
    if (event.target === box) close();
  });

  document.addEventListener('keydown', (event) => {
    if (box.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      open(index - 1, false);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      open(index + 1, false);
    } else if (event.key === 'Tab') {
      // Keep focus inside the dialog: close, prev, next.
      const ring = [closeButton, prevButton, nextButton];
      const at = ring.indexOf(document.activeElement);
      event.preventDefault();
      ring[(at + (event.shiftKey ? -1 : 1) + ring.length) % ring.length].focus();
    }
  });
})();
