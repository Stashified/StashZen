/**
 * ScenesPage — renders the grid, the carousel or the coverflow.
 *
 * This was HomePage until 0.15.0, when Home became the showroom and the full
 * scene listing moved to its own tab. The body is unchanged: this is still the
 * one place the scene listing's three view modes are chosen.
 *
 * `mode` arrives as a prop rather than being read off `controls`: it is a
 * per-section preference now, stored in `settings.viewModes[tab]` and owned by
 * App, whereas `controls` is the shared request state (sort, order, cols,
 * filter) that every section keeps its own copy of. Folding the two together
 * is what made the mode global to the app and forgotten on every launch.
 */

import VideoGrid from '../components/VideoGrid.jsx';
import Carousel from '../components/Carousel.jsx';
import VideoCoverflow from '../components/VideoCoverflow.jsx';
import ItemList from '../components/ItemList.jsx';
import { SCENE_VIEW } from '../components/carouselViews.js';

export default function ScenesPage({
  mode, controls, objectFilter, searchQuery, onVideoSelect, onVideoLongPress,
}) {
  const shared = { controls, objectFilter, searchQuery };

  if (mode === 'coverflow') {
    return <VideoCoverflow {...shared} onVideoSelect={onVideoSelect} onVideoLongPress={onVideoLongPress} />;
  }
  if (mode === 'list') {
    return <ItemList {...shared} view={SCENE_VIEW} onSelect={onVideoSelect} onLongPress={onVideoLongPress} />;
  }
  if (mode === 'carousel') {
    return <Carousel {...shared} view={SCENE_VIEW} onSelect={onVideoSelect} onLongPress={onVideoLongPress} />;
  }
  return <VideoGrid {...shared} onVideoSelect={onVideoSelect} onVideoLongPress={onVideoLongPress} />;
}
