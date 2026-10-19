/**
 * The rows the image viewer's info panel draws.
 *
 * Pure and separate from the component so the empty-value rules can be
 * unit-tested: most of these fields are absent on a real library (no
 * photographer, no studio, no code), and an empty row is worse than no row.
 */

import { formatBytes } from './format.js';

function names(list, max) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const shown = list.slice(0, max).map(x => x?.name || x?.title).filter(Boolean);
  if (shown.length === 0) return null;
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
}

export function buildImageInfoRows(detail) {
  if (!detail) return [];
  const rows = [];

  if (detail.studio?.name) {
    rows.push({ key: 'studio', label: 'Studio', value: detail.studio.name });
  }
  if (detail.photographer) {
    rows.push({ key: 'photographer', label: 'Photographer', value: detail.photographer });
  }
  if (detail.code) {
    rows.push({ key: 'code', label: 'Code', value: detail.code });
  }
  if (detail.width && detail.height) {
    rows.push({ key: 'resolution', label: 'Resolution', value: `${detail.width}×${detail.height}` });
  }
  if (detail.fileSize > 0) {
    rows.push({ key: 'size', label: 'File size', value: formatBytes(detail.fileSize) });
  }
  if (detail.rating100 > 0) {
    rows.push({
      key: 'rating',
      label: 'Rating',
      value: `★ ${(detail.rating100 / 10).toFixed(1)}`,
    });
  }
  if (detail.oCounter > 0) {
    rows.push({ key: 'likes', label: 'Likes', value: String(detail.oCounter) });
  }

  const tags = names(detail.tags, 6);
  if (tags) rows.push({ key: 'tags', label: 'Tags', value: tags, clamp: true });

  const performers = names(detail.performers, 6);
  if (performers) rows.push({ key: 'performers', label: 'Performers', value: performers, clamp: true });

  const galleries = names(detail.galleries, 4);
  if (galleries) rows.push({ key: 'galleries', label: 'Galleries', value: galleries, clamp: true });

  if (detail.details) {
    rows.push({ key: 'details', label: 'Details', value: detail.details, clamp: true });
  }

  return rows;
}
