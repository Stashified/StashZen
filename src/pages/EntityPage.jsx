/**
 * EntityPage — the grid, or the carousel when this section's mode is one.
 *
 * One page for all four browse-only sections, parameterised by the descriptor,
 * rather than four near-identical files. `PerformersPage` is the same twenty
 * lines; the plan listed four pages (`TagsPage`, `StudiosPage`,
 * `GalleriesPage`, `ImagesPage`) and four copies of a delegate that names a
 * different constant in each is exactly what the descriptor exists to avoid.
 *
 * `mode` is a prop rather than `controls.mode`; see ScenesPage's header for why.
 */

import EntityGrid from '../components/EntityGrid.jsx';
import Carousel from '../components/Carousel.jsx';
import ItemList from '../components/ItemList.jsx';

export default function EntityPage({ view, mode, controls, objectFilter, searchQuery, onSelect }) {
  const shared = { controls, objectFilter, searchQuery, view };

  if (mode === 'carousel') {
    return <Carousel {...shared} onSelect={onSelect} />;
  }
  if (mode === 'list') {
    return <ItemList {...shared} onSelect={onSelect} />;
  }
  return <EntityGrid {...shared} onSelect={onSelect} />;
}
