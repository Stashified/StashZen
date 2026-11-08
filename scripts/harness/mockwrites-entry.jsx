/**
 * Test-mode read-back for the quick writes.
 *
 * Test mode has no server, so the detail fetchers rebuild their fixtures. A
 * write must still be visible when the sheet is reopened, and a second press
 * must toggle from the written value rather than the fixture's. No React here:
 * the services are the claim.
 */

import { setSettings } from '../../src/utils/settings.js';
import { fetchTagInfo, setTagFavorite } from '../../src/utils/tagService.js';
import { fetchStudioInfo, setStudioFavorite } from '../../src/utils/studioService.js';
import { fetchGalleryInfo, updateGallery } from '../../src/utils/galleryService.js';
import {
  fetchImageInfo, updateImage,
  incrementImageO, decrementImageO, resetImageO,
} from '../../src/utils/imageService.js';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

async function run() {
  setSettings({ useMock: true });

  // Tag: the write survives a reopened sheet, and a second press turns it off.
  const tagBefore = await fetchTagInfo('tag-1');
  await setTagFavorite('tag-1', !tagBefore.favorite);
  const tagAfter = await fetchTagInfo('tag-1');
  check('M1 a tag favourite is still set when the sheet reopens',
    !!tagAfter && tagAfter.favorite === !tagBefore.favorite,
    `before=${tagBefore?.favorite} after=${tagAfter?.favorite}`);
  await setTagFavorite('tag-1', tagBefore.favorite);
  const tagBack = await fetchTagInfo('tag-1');
  check('M2 and a second press turns it off again',
    tagBack?.favorite === tagBefore.favorite,
    `back=${tagBack?.favorite}`);

  // Studio: same contract.
  const studioBefore = await fetchStudioInfo('studio-1');
  await setStudioFavorite('studio-1', !studioBefore.favorite);
  const studioAfter = await fetchStudioInfo('studio-1');
  check('M3 a studio favourite survives reopening, and toggles back',
    studioAfter?.favorite === !studioBefore.favorite,
    `before=${studioBefore?.favorite} after=${studioAfter?.favorite}`);
  await setStudioFavorite('studio-1', studioBefore.favorite);
  check('M4 ...to its original value',
    (await fetchStudioInfo('studio-1'))?.favorite === studioBefore.favorite);

  // Gallery: rating and organised.
  const galleryBefore = await fetchGalleryInfo('gallery-1');
  await updateGallery({ id: 'gallery-1', rating100: 55 });
  const galleryRated = await fetchGalleryInfo('gallery-1');
  check('M5 a gallery rating survives reopening',
    galleryRated?.rating100 === 55 && galleryRated?.rating === '5.5',
    `rating100=${galleryRated?.rating100} label=${galleryRated?.rating}`);
  await updateGallery({ id: 'gallery-1', organized: true });
  const galleryOrganized = await fetchGalleryInfo('gallery-1');
  check('M6 an organised toggle survives reopening, without clearing the rating',
    galleryOrganized?.organized === true && galleryOrganized?.rating100 === 55,
    `organized=${galleryOrganized?.organized} rating100=${galleryOrganized?.rating100}`);
  await updateGallery({ id: 'gallery-1', rating100: galleryBefore.rating100, organized: false });

  // Image: the panel derives its detail from the listing row, so pass one.
  const item = { id: 'image-1', title: 'VERIFY', resolution: '100x100', rating: 4.0, o_counter: 2 };
  const imageBefore = await fetchImageInfo(item);
  check('M7 the image detail starts from the row',
    imageBefore?.rating100 === 40 && imageBefore?.oCounter === 2,
    `rating100=${imageBefore?.rating100} o=${imageBefore?.oCounter}`);
  await updateImage({ id: 'image-1', rating100: 80, organized: true });
  const imageEdited = await fetchImageInfo(item);
  check('M8 an image rating and organised flag survive reopening',
    imageEdited?.rating100 === 80 && imageEdited?.organized === true,
    `rating100=${imageEdited?.rating100} organized=${imageEdited?.organized}`);

  // O-counter: the mock answers from the count on screen, like the server does.
  check('M9 the O increment adopts the next count',
    (await incrementImageO('image-1', 2)) === 3);
  check('M10 the O decrement adopts the previous count',
    (await decrementImageO('image-1', 3)) === 2);
  check('M11 the O reset lands on zero',
    (await resetImageO('image-1', 2)) === 0);
  const imageCount = await fetchImageInfo(item);
  check('M12 and the sheet reopens on the written count',
    imageCount?.oCounter === 0, `o=${imageCount?.oCounter}`);
}

run().then(finish).catch(async (e) => {
  check('M99 the driver itself threw', false,
    String(e && e.stack ? e.stack.split('\n')[0] : e));
  await finish();
});
