/**
 * PerformersPage — the performer grid, or the carousel/list for this section's
 * mode. `mode` is a prop rather than `controls.mode`; see ScenesPage's header.
 */

import PerformerGrid from '../components/PerformerGrid.jsx';
import Carousel from '../components/Carousel.jsx';
import ItemList from '../components/ItemList.jsx';
import { PERFORMER_VIEW } from '../components/carouselViews.js';

export default function PerformersPage({
  mode, controls, objectFilter, searchQuery, onPerformerSelect,
}) {
  const shared = { controls, objectFilter, searchQuery };

  if (mode === 'carousel') {
    return <Carousel {...shared} view={PERFORMER_VIEW} onSelect={onPerformerSelect} />;
  }
  if (mode === 'list') {
    return <ItemList {...shared} view={PERFORMER_VIEW} onSelect={onPerformerSelect} />;
  }
  return <PerformerGrid {...shared} onPerformerSelect={onPerformerSelect} />;
}
