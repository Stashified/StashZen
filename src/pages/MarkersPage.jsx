/**
 * MarkersPage — renders the marker grid, or the carousel when this section's
 * mode is set to one. `mode` is a prop rather than `controls.mode`; see
 * ScenesPage's header for why.
 */

import MarkerGrid from '../components/MarkerGrid.jsx';
import Carousel from '../components/Carousel.jsx';
import ItemList from '../components/ItemList.jsx';
import { MARKER_VIEW } from '../components/carouselViews.js';

export default function MarkersPage({
  mode, controls, objectFilter, searchQuery, onMarkerSelect,
}) {
  const shared = { controls, objectFilter, searchQuery };

  if (mode === 'carousel') {
    return <Carousel {...shared} view={MARKER_VIEW} onSelect={onMarkerSelect} />;
  }
  if (mode === 'list') {
    return <ItemList {...shared} view={MARKER_VIEW} onSelect={onMarkerSelect} />;
  }
  return <MarkerGrid {...shared} onMarkerSelect={onMarkerSelect} />;
}
