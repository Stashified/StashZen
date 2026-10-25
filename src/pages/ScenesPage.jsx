/**
 * ScenesPage — the scene listing's grid, list, carousel or coverflow.
 *
 * `mode` arrives as a prop, not off `controls`: it is a per-section preference
 * (`settings.viewModes[tab]`, owned by App), whereas `controls` is shared
 * request state. Folding the two together made the mode global and forgotten
 * on every launch.
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
