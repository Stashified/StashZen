/**
 * MarkersPage — the marker grid, or the carousel/list for this section's mode.
 * `mode` is a prop rather than `controls.mode`; see ScenesPage's header for why.
 */

import MarkerGrid from '../components/MarkerGrid.jsx';
import Carousel from '../components/Carousel.jsx';
import ItemList from '../components/ItemList.jsx';
import { MARKER_VIEW } from '../components/carouselViews.js';

export default function MarkersPage({
  mode, controls, objectFilter, searchQuery, onMarkerSelect, onMarkerLongPress,
}) {
  const shared = { controls, objectFilter, searchQuery };
  const press = { onSelect: onMarkerSelect, onLongPress: onMarkerLongPress };

  if (mode === 'carousel') {
    return <Carousel {...shared} view={MARKER_VIEW} {...press} />;
  }
  if (mode === 'list') {
    return <ItemList {...shared} view={MARKER_VIEW} {...press} />;
  }
  return <MarkerGrid {...shared} onMarkerSelect={onMarkerSelect} onMarkerLongPress={onMarkerLongPress} />;
}
