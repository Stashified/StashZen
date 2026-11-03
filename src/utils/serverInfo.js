/**
 * serverInfo.js: the current server version, readable outside React.
 *
 * Service loaders and the filter translator run in effects or callbacks, not
 * in App's render, so a hook value cannot reach them without prop drilling.
 * `useServerVersion` owns the fetch and writes the resolved version here.
 *
 * Null means "not known yet" or "no server", which every caller treats as the
 * 0.31 baseline. Hiding a gated field costs a UI entry; sending one to an older
 * server fails the whole query.
 */

let serverVersion = null;

export function setServerVersion(version) {
  serverVersion = version || null;
}

export function getServerVersion() {
  return serverVersion;
}
