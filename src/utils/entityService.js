/**
 * entityService.js — one loader for the four browse-only sections.
 *
 * Tags, Studios, Galleries and Images differ in exactly four things: the
 * GraphQL root, the `*_filter` argument name, the result field, and row
 * normalisation. The list cache, `translateFilter`, FindFilterType variables
 * and Test-mode sort/paginate are identical, which is what this factory exists
 * to stop writing four times.
 *
 * **`performerService.js` and `markerService.js` are deliberately NOT moved
 * onto this.** They were TV-verified as they are, and routing them through a
 * new loader would need its own differential before it could be called safe.
 * The factory reproduces their observable behaviour: same cache key shape,
 * variables, mock ordering and `{ total, page }` return.
 *
 * THE ONE DIVERGENCE: the mock branch here honours `q`; the older services'
 * does not. A search box that does nothing in Test mode is worth fixing by
 * migrating those two later, not by making four new sections worse. `filter`
 * is ignored in Test mode everywhere — a stored filter is a server query and
 * there is no server.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { translateFilter } from './filterTranslate.js';
import { mockComparator } from './mockSort.js';
import { baseSort, stableSort } from './randomSort.js';

/**
 * Build a list service.
 *
 * `kind` and `itemsKey` are usually equal (`tags`/`tags`) but separate: `kind`
 * namespaces the cache key, `itemsKey` is the field the GraphQL result nests
 * the list under. `filterArg` must be passed — `tag_filter` for `findTags` but
 * `image_filter` for `findImages`; there is no reliable rule.
 *
 * `searchFields` are what Test-mode `q` matches. `heroQuery` is an optional
 * heavier `query` used only for `fetch({ hero: true })`: tag descriptions and
 * studio details are paragraphs rendered only by the Carousel hero, so grids
 * and list rows would pay for every row on every page. Fields shown elsewhere
 * (aliases, parent) stay in the base query because list rows render them.
 */
export function createEntityService({
  kind,
  root,
  itemsKey,
  filterArg,
  filterType,
  query,
  heroQuery = null,
  normalize,
  mock,
  searchFields = [],
  mockSortKey = null,
}) {
  const cache = createListCache();

  async function load({ sort, order, filter, q, page, limit, query: selectedQuery }) {
    if (getSettings().useMock) {
      await new Promise(r => setTimeout(r, 400));

      let all = mock();
      const needle = (q || '').trim().toLowerCase();
      if (needle && searchFields.length) {
        all = all.filter(item => searchFields.some(
          f => String(item[f] ?? '').toLowerCase().includes(needle),
        ));
      }
      // `sort` may be the seeded spelling (`random_<n>`), which the comparator
      // does not know; `baseSort` maps it back so Test mode keeps its stable
      // id-rank shuffle.
      all.sort(mockComparator(baseSort(sort), order, mockSortKey));

      const total = all.length;
      const start = (page - 1) * limit;
      return { [itemsKey]: all.slice(start, start + limit), total, page };
    }

    const variables = {
      filter: {
        q,
        page,
        per_page: limit,
        sort,
        direction: order === 'asc' ? 'ASC' : 'DESC',
      },
      // Translated at query time, not at the call site — see the note in
      // videoService.js. Raw is what stays in the cache key.
      [filterArg]: translateFilter(filter, filterType),
    };

    const data = await runQuery(selectedQuery, variables);
    const rows = data?.[root]?.[itemsKey] || [];

    return {
      [itemsKey]: rows.map(normalize),
      total: data?.[root]?.count || 0,
      page,
    };
  }

  return {
    fetch(opts = {}) {
      const {
        sort = 'created_at', order = 'desc', filter = null,
        q = '', page = 1, limit = 40, hero = false,
        // `cache: false` for background loops that would evict visible pages
        // (the gallery slideshow fetches up to 100). Same request, no memo.
        cache: useCache = true,
      } = opts;

      // The variants answer different documents, so they must not share a
      // cache entry: a base page would leave the carousel's blurb empty, and a
      // hero page would make grids pay for fields they never draw.
      const useHeroQuery = hero && !!heroQuery;

      // `random` is re-shuffled per request, so a listing would overlap its
      // own pages and the no-progress stop could end a short list early.
      // Seeding it from the request identity makes one listing one
      // permutation; see randomSort.js. The `:hero` suffix is excluded — both
      // variants are the same listing.
      const requestSort = stableSort(sort, kind, filter, q);

      const loader = () => load({
        sort: requestSort, order, filter, q, page, limit,
        query: useHeroQuery ? heroQuery : query,
      });

      if (!useCache) return loader();
      return cache.get(
        listCacheKey(
          useHeroQuery ? `${kind}:hero` : kind,
          requestSort, order, filter, q, page, limit,
        ),
        loader,
      );
    },
  };
}
