/**
 * EntityPage, the grid, or the carousel/list when this section's mode is one.
 *
 * One page for all four browse-only sections, parameterised by the descriptor:
 * four near-identical files is what the descriptor exists to avoid. `mode` is a
 * prop rather than `controls.mode`; see ScenesPage's header for why.
 */

import EntityGrid from '../components/EntityGrid.jsx';
import Carousel from '../components/Carousel.jsx';
import ItemList from '../components/ItemList.jsx';

export default function EntityPage({
  view, mode, controls, objectFilter, searchQuery, onSelect, onLongPress,
}) {
  const shared = { controls, objectFilter, searchQuery, view };
  const press = { onSelect, onLongPress };

  if (mode === 'carousel') {
    return <Carousel {...shared} {...press} />;
  }
  if (mode === 'list') {
    return <ItemList {...shared} {...press} />;
  }
  return <EntityGrid {...shared} {...press} />;
}
