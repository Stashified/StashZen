/**
 * Spike (manual, NOT in sweep.sh): could downscaled bitmaps make a cover grid
 * cheaper than <img> at full resolution?
 *
 * The question: every cover Stash serves is a full-HD 1920x1080 file, and a
 * 6-column grid mounts 40 of them at once. If the engine rasterises each at
 * its natural size, that is ~300 MB of texture for a grid whose cards are
 * ~300 px wide. `createImageBitmap(blob, { resizeWidth, resizeHeight })` can
 * decode straight to a smaller size, so the app could feed the cards 480-px
 * bitmaps instead.
 *
 * What this measures: the one-time CPU cost of that downscale, in the harness
 * browser (Firefox, software compositing), against simply letting <img> decode
 * the same blobs. It CANNOT measure the thing the TV pays for — GPU memory and
 * raster time — because headless Firefox has no TV compositor, and Chromium
 * already has a "decode to display size" heuristic. Treat the numbers as "is
 * the downscale affordable", never as "is it worth it".
 *
 * The TV verdict needs the device: mount both grids on the set and watch
 * memory (Settings → Performance), scroll stutter and time-to-first-frame.
 * Until then this is why no image code changed.
 *
 * Measured 2026-11-01 (harness browser, 24 full-HD JPEGs): <img> decode
 * 4.2 ms/image; createImageBitmap 1920→480 19.0 ms/image (4.6×), plus a
 * 0.6 ms blit. A grid's worth of downscales costs ~0.5 s once, which is
 * affordable only if it is cached per cover and the TV's texture memory turns
 * out to be the actual bottleneck. No evidence for that yet.
 *
 *   node-free: run with
 *   ENTRY=scripts/harness/spike-images-entry.jsx NAME=spikeimg PORT=8871 \
 *     bash scripts/harness/run.sh
 */

import '../../src/index.css';

const COUNT = 24;
const FULL = [1920, 1080];
const SMALL = [480, 270];

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// Deterministic noise, so the JPEGs are not degenerate and do not compress to
// nothing (a flat image decodes faster than anything Stash serves).
function drawArt(ctx, seed) {
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, FULL[0], FULL[1]);
  for (let i = 0; i < 400; i += 1) {
    const x = (seed * 7919 + i * 104729) % FULL[0];
    const y = (seed * 6151 + i * 15485863) % FULL[1];
    ctx.fillStyle = `hsl(${(seed * 37 + i * 11) % 360}, 55%, ${30 + (i % 40)}%)`;
    ctx.fillRect(x, y, 60, 34);
  }
}

async function makeBlobs() {
  const blobs = [];
  for (let i = 0; i < COUNT; i += 1) {
    const c = document.createElement('canvas');
    c.width = FULL[0];
    c.height = FULL[1];
    drawArt(c.getContext('2d'), i + 1);
    blobs.push(await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9)));
  }
  return blobs;
}

async function run() {
  const blobs = await makeBlobs();
  check('fixture: full-HD JPEG covers built', blobs.length === COUNT && blobs.every(Boolean),
    `${blobs.length} blobs, ${(blobs[0].size / 1024).toFixed(0)} KiB each`);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:20px;padding:24px';
  document.body.appendChild(grid);

  // ── A: <img> at full resolution, as shipped ────────────
  let t0 = performance.now();
  const imgs = blobs.map((blob) => {
    const img = new Image();
    img.style.cssText = 'width:100%;height:auto;display:block';
    img.src = URL.createObjectURL(blob);
    grid.appendChild(img);
    return img;
  });
  await Promise.all(imgs.map(i => i.decode().catch(() => {})));
  const fullMs = performance.now() - t0;
  const natural = imgs[0].naturalWidth;

  // ── B: createImageBitmap downscale, then draw ──────────
  t0 = performance.now();
  const bitmaps = await Promise.all(blobs.map(blob =>
    createImageBitmap(blob, { resizeWidth: SMALL[0], resizeHeight: SMALL[1], resizeQuality: 'low' })));
  const resizeMs = performance.now() - t0;

  grid.textContent = '';
  t0 = performance.now();
  const canvases = bitmaps.map((bm) => {
    const c = document.createElement('canvas');
    c.width = SMALL[0];
    c.height = SMALL[1];
    c.style.cssText = 'width:100%;height:auto;display:block';
    c.getContext('2d').drawImage(bm, 0, 0);
    grid.appendChild(c);
    return c;
  });
  const drawMs = performance.now() - t0;

  const w = bitmaps[0].width;
  check('fixture: the full-res path really is full-res', natural === FULL[0], `${natural}px wide`);
  check('fixture: the downscale really is smaller', w === SMALL[0], `${w}px wide`);

  const per = (ms) => `${(ms / COUNT).toFixed(1)} ms/image`;
  check(`A <img> full-res decode ×${COUNT}`, fullMs >= 0, `${fullMs.toFixed(0)} ms total, ${per(fullMs)}`);
  check(`B createImageBitmap ${FULL[0]}→${SMALL[0]} ×${COUNT}`, resizeMs >= 0,
    `${resizeMs.toFixed(0)} ms total, ${per(resizeMs)}`);
  check(`C canvas blit at ${SMALL[0]}×${SMALL[1]} ×${COUNT}`, drawMs >= 0,
    `${drawMs.toFixed(0)} ms total, ${per(drawMs)}, ${canvases.length} mounted`);
  check('D the downscale costs more than one decode', resizeMs > fullMs,
    `B is ${(resizeMs / fullMs).toFixed(1)}× A — the saving it buys must be on the TV's raster side`);
  check('E the two paths mount the same count', imgs.length === canvases.length,
    `${imgs.length} imgs, ${canvases.length} canvases`);

  // Cleanups so the page does not hold the bitmaps while the result uploads.
  imgs.forEach(i => URL.revokeObjectURL(i.src));
  bitmaps.forEach(b => b.close());

  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

run().catch(async (e) => {
  results.push({ name: 'spike crashed', pass: false, detail: String(e && e.stack || e) });
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  }).catch(() => {});
  await fetch('/done', { method: 'POST' }).catch(() => {});
});
