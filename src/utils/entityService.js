/**
 * entityService.js — one loader for the four browse-only sections.
 *
 * Tags, Studios, Galleries and Images differ in exactly four things: the
 * GraphQL root, the `*_filter` argument's name, the field the list comes back
 * under, and how a row is normalised. Everything else — the list cache, the
 * `translateFilter` call, the FindFilterType variables, the Test-mode sort and
 * paginate — is the same code four times, which is what this file exists to
 * stop being written four times.
 *
 * **`performerService.js` and `markerService.js` are deliberately NOT moved onto
 * this.** They were TV-verified in their current form, and routing them through
 * a new shared loader is a behaviour-neutral refactor that would need its own
 * differential before it could be called safe — a separate change with a
 * separate control experiment, not something to fold into the phase that adds
 * four sections. The factory below was written to reproduce their observable
 * behaviour rather than to improve on it: same cache key shape, same variables,
 * same mock ordering, same `{ total, page }` return.
 *
 * THE ONE PLACE IT DIVERGES, stated because it is a real difference: the mock
 * branch here honours `q`, and the three older services' does not. A search box
 * that silently does nothing in Test mode is worth the inconsistency, and the
 * honest fix is to move those two onto this factory later — not to make four
 * new sections worse in order to match them. `filter` is still ignored in Test
 * mode by all of them, because a stored filter is a server-side query and there
 * is no server; that one is a limitation rather than an oversight.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';
import { createListCache, listCacheKey } from './listCache.js';
import { translateFilter } from './filterTranslate.js';
import { mockComparator } from './mockSort.js';
import { baseSort, stableSort } from './randomSort.js';

// The mock comparator now lives in mockSort.js, shared with the three older
// services: its `alias` argument is the same rule described there, and it
// adds the stable-rank handling of the `random` sort that four of the five
// listings offer and none of the mocks used to honour.

/**
 * Build a list service.
 *
 * `kind` and `itemsKey` are usually equal (`tags`/`tags`) and are separate
 * because they are separate things: `kind` namespaces the cache key, `itemsKey`
 * is the field the GraphQL result nests the list under. `filterArg` has to be
 * passed rather than derived — it is `tag_filter` for `findTags` but
 * `image_filter` for `findImages`, and there is no reliable rule.
 *
 * `searchFields` are the fields the Test-mode `q` is matched against. A real
 * search is the server's; this is only so the box does something.
 *
 * `heroQuery` is an optional heavier variant of `query`, used only when the
 * caller asks for it (`fetch({ hero: true })`). The tag description and the
 * studio details are free text that can run to paragraphs, and only the
 * Carousel hero renders them; grids and list rows would pay for every row on
 * every page. A service without a `heroQuery` ignores the flag. Anything that
 * *is* shown elsewhere — a tag's aliases, a studio's parent — stays in the
 * base query, because the list rows render the hero meta model too.
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
        // `cache: false` is for a background loop that would otherwise evict
        // the pages the user can actually see (the gallery slideshow fetches
        // up to 100 pages). The request is identical; only the memo is skipped.
        cache: useCache = true,
      } = opts;

      // The two variants answer different documents, so they must not share a
      // cache entry — a base page served to the carousel would leave its blurb
      // empty, and a hero page served to a grid would carry the weight the
      // base query exists to avoid.
      const useHeroQuery = hero && !!heroQuery;

      // `random` is re-shuffled by the server on every request, so a listing
      // would overlap its own pages and the no-progress stop could end a short
      // list early (the review's R8). Seeding it from the request identity
      // makes one listing one permutation across all its pages; see
      // randomSort.js. The `:hero` suffix is deliberately not part of the
      // identity — the two variants are the same listing.
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
