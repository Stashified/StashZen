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
 */
export function createEntityService({
  kind,
  root,
  itemsKey,
  filterArg,
  filterType,
  query,
  normalize,
  mock,
  searchFields = [],
  mockSortKey = null,
}) {
  const cache = createListCache();

  async function load({ sort, order, filter, q, page, limit }) {
    if (getSettings().useMock) {
      await new Promise(r => setTimeout(r, 400));

      let all = mock();
      const needle = (q || '').trim().toLowerCase();
      if (needle && searchFields.length) {
        all = all.filter(item => searchFields.some(
          f => String(item[f] ?? '').toLowerCase().includes(needle),
        ));
      }
      all.sort(mockComparator(sort, order, mockSortKey));

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

    const data = await runQuery(query, variables);
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
        q = '', page = 1, limit = 40,
      } = opts;

      return cache.get(
        listCacheKey(kind, sort, order, filter, q, page, limit),
        () => load({ sort, order, filter, q, page, limit }),
      );
    },
  };
}
