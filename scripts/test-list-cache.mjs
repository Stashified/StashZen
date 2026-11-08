#!/usr/bin/env node
/**
 * test-list-cache.mjs: shared in-flight requests, including abort recovery
 *
 *   node scripts/test-list-cache.mjs
 *
 * The shared loader is created by the first caller and closes over that
 * caller's signal. If it is aborted, every joiner would reject with AbortError
 * unless it recovers through its own loader.
 */

globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

const { createListCache } = await import('../src/utils/listCache.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function pending(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

// ── coalescing ───────────────────────────────────────────
{
  const cache = createListCache();
  let calls = 0;
  const loader = () => { calls += 1; return Promise.resolve('value'); };
  const [a, b] = await Promise.all([cache.get('k', loader), cache.get('k', loader)]);
  check('two callers share one request', calls === 1, `calls=${calls}`);
  check('both callers get the value', a === 'value' && b === 'value');
  check('the value is cached',
    await cache.get('k', () => Promise.resolve('other')) === 'value');
}

// ── the owner aborts while a joiner waits ────────────────
{
  const cache = createListCache();
  const ownerSignal = new AbortController();
  let ownerCalls = 0;
  let joinerCalls = 0;

  const owner = cache.get('k', () => {
    ownerCalls += 1;
    return pending(ownerSignal.signal);
  });
  const joiner = cache.get('k', () => {
    joinerCalls += 1;
    return Promise.resolve('recovered');
  });

  check('a joiner waits on the shared request', joinerCalls === 0, `calls=${joinerCalls}`);
  ownerSignal.abort();
  const results = await Promise.allSettled([owner, joiner]);
  check('the owner sees its own abort',
    results[0].status === 'rejected' && results[0].reason?.name === 'AbortError',
    JSON.stringify(results[0]));
  check('the joiner recovers through its own loader',
    results[1].status === 'fulfilled' && results[1].value === 'recovered',
    JSON.stringify(results[1]));
  check('each loader ran once', ownerCalls === 1 && joinerCalls === 1,
    `owner=${ownerCalls} joiner=${joinerCalls}`);
  check('the recovered value is cached',
    await cache.get('k', () => Promise.resolve('other')) === 'recovered');
}

// ── a real failure is not retried ────────────────────────
{
  const cache = createListCache();
  let joinerCalls = 0;
  const boom = new Error('boom');
  const owner = cache.get('k', () => Promise.reject(boom));
  const joiner = cache.get('k', () => {
    joinerCalls += 1;
    return Promise.resolve('x');
  });
  const results = await Promise.allSettled([owner, joiner]);
  check('a real failure reaches both callers',
    results[0].status === 'rejected' && results[1].status === 'rejected'
      && results[1].reason === boom,
    JSON.stringify(results));
  check('a real failure is not retried', joinerCalls === 0, `calls=${joinerCalls}`);
}

// ── clearing one kind leaves the others ─────────────────
{
  const { listCacheKey } = await import('../src/utils/listCache.js');
  const cache = createListCache();
  const tagKey = listCacheKey('tags', 'name', 'asc', null, '', 1, 40);
  const tagHero = listCacheKey('tags:hero', 'name', 'asc', null, '', 1, 40);
  const studioKey = listCacheKey('studios', 'name', 'asc', null, '', 1, 40);

  await cache.get(tagKey, () => Promise.resolve('tag'));
  await cache.get(tagHero, () => Promise.resolve('tag-hero'));
  await cache.get(studioKey, () => Promise.resolve('studio'));

  cache.clearKind('tags');
  check('clearKind drops the base pages',
    await cache.get(tagKey, () => Promise.resolve('fresh-tag')) === 'fresh-tag');
  check('clearKind drops the hero pages',
    await cache.get(tagHero, () => Promise.resolve('fresh-hero')) === 'fresh-hero');
  check('clearKind keeps other kinds',
    await cache.get(studioKey, () => Promise.resolve('fresh-studio')) === 'studio');
}

// ── a page in flight across the clear is not stored ─────
{
  const { listCacheKey } = await import('../src/utils/listCache.js');
  const cache = createListCache();
  const key = listCacheKey('tags', 'name', 'asc', null, '', 1, 40);
  let resolve;
  const stale = cache.get(key, () => new Promise(r => { resolve = r; }));
  cache.clearKind('tags');
  resolve('stale-page');
  await stale;
  check('an in-flight page from before the clear is not cached',
    await cache.get(key, () => Promise.resolve('fresh-page')) === 'fresh-page');
}

// ── a joiner that is itself aborted settles ──────────────
{
  const cache = createListCache();
  const ownerSignal = new AbortController();
  const owner = cache.get('k', () => pending(ownerSignal.signal));
  const joiner = cache.get('k', () => {
    const err = new Error('joiner aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  });
  ownerSignal.abort();
  const results = await Promise.allSettled([owner, joiner]);
  check('an aborted joiner gets AbortError, not a retry loop',
    results[1].status === 'rejected' && results[1].reason?.name === 'AbortError',
    JSON.stringify(results[1]));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
