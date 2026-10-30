#!/usr/bin/env bash
# Runs every driver and collects the result JSONs under /tmp/diff/$1/<name>.json,
# so two revisions can be compared byte-for-byte.
#
#   A differential proves neutrality, never coverage. A check red on both sides
#   leaves a clean diff and is still red — read the tally on both sides.
#
#   Run it *before* any version bump. __APP_VERSION__ is interpolated into the
#   DOM, so bumping package.json partway changes firstrun, controls and
#   actions-settings and reads as a regression.
#
#   Lint runs first and aborts the sweep: it is a step of the CI build, and no
#   driver can see a tree CI would not build. SKIP_LINT=1 escapes it.
#
#   Disk is a real failure mode. Each run leaves a Firefox profile and a bundle
#   under /tmp/diff-<label>-<name>, 50–160 MB apiece. Green drivers delete their
#   dir; a red one keeps it. `df -h /tmp` when one stalls.
#
#   The drivers run in a pool, WORKERS at a time (default 3). Concurrency hung
#   in the past because every run shared port 8850; each job now gets its own
#   port and NAME dir. Drivers whose assertions read the clock (`serial=1`) run
#   one at a time after the pool, so load cannot move their timings.
#
# Usage:  bash scripts/harness/sweep.sh [--quick] <label>
set -u

MODE=full
if [ "${1:-}" = "--quick" ]; then MODE=quick; shift; fi
LABEL=${1:?usage: sweep.sh [--quick] <label>}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=/tmp/diff/$LABEL
BASE_PORT=8850
SERIAL_PORT=8889
WORKERS=${WORKERS:-3}
mkdir -p "$OUT"
# Leftovers from an interrupted round of the same label. Safe because sweeps
# are run one at a time; never while one is in flight.
rm -rf /tmp/diff-"$LABEL"-*

# name|entry|query|update-check|serial
FULL_JOBS=(
  "list-grid|list-entry.jsx|?view=grid|0|0"
  "list-carousel|list-entry.jsx|?view=carousel|0|0"
  "list-coverflow|list-entry.jsx|?view=coverflow|0|0"
  # `?view=random` is not a key in VIEWS, so the `|| VIEWS.grid` fallback renders
  # the same VideoGrid as list-grid. It is not a byte-duplicate: G6 tests the raw
  # query string, so `random` takes the skip branch and reports 21 checks to
  # grid's 27. It stays because its count is a baseline other runs are diffed
  # against.
  "list-random|list-entry.jsx|?view=random|0|0"
  "list-list|list-entry.jsx|?view=list|0|0"
  # The usePagedList re-entrancy probe: one tick, two page triggers, and the
  # identity change while a page is in flight. Red control in the entry header.
  "pagedlist|pagedlist-entry.jsx||0|0"
  "boot|boot-entry.jsx||0|0"
  "markerfix|markerfix-entry.jsx||0|0"
  # The focus-move paint contract of all four classic-grid cards. Structural,
  # not a timing test, but it reads paint order and runs alone.
  "focuspaint|focuspaint-entry.jsx||0|1"
  "roworder|roworder-entry.jsx||0|0"
  "rail|rail-entry.jsx||0|0"
  # The Search tab: one card type per section, the hand-off into a tab with the
  # query applied, and the return trip to the same results.
  "search|search-entry.jsx||0|0"
  "sections|sections-entry.jsx||0|0"
  "showroom|showroom-entry.jsx||0|0"
  # Leaving a tab is the TV's refresh: the arriving page must go to the wire
  # rather than the module-scoped list cache.
  "refresh|refresh-entry.jsx||0|1"
  "menu|menu-entry.jsx||0|0"
  "menu-actions|menu-entry.jsx|?view=menu|0|0"
  "menu-queue|menu-entry.jsx|?view=queue|0|0"
  "menu-saves|menu-entry.jsx|?view=saves|0|0"
  "menu-buttons|menu-entry.jsx|?view=buttons|0|0"
  "preview|preview-entry.jsx||0|1"
  "codec|codec-entry.jsx||0|0"
  # The TV engine against a fake AVPlay: the decisions around the engine, not
  # that it decodes. Its arrival verdict is a 2.5 s clock.
  "avplay|avplay-entry.jsx||0|1"
  "controls|controls-entry.jsx||0|0"
  "detail|entry.jsx||0|0"
  "performer|performer-entry.jsx||0|0"
  "performerback|performerback-entry.jsx||0|0"
  "filter|filter-entry.jsx||0|0"
  "firstrun|firstrun-entry.jsx||0|0"
  "theme|theme-entry.jsx||0|0"
  "actions-settings|actions-entry.jsx|?view=settings|0|0"
  "actions-exit|actions-entry.jsx|?view=exit|0|0"
  "settings-status|settings-status-entry.jsx||0|0"
  # Ordering, cache slots and key strings rather than a screen; the in-flight
  # identity checks read timing, so it runs alone.
  "datalayer|datalayer-entry.jsx||0|1"
  "errorboundary|errorboundary-entry.jsx||0|0"
  "pinlock|pinlock-entry.jsx||0|0"
  "views|views-entry.jsx||0|0"
  "longpress|longpress-entry.jsx||0|0"
  # The public-only update check, in both build shapes: `update` is the public
  # build, `update-off` proves the private one has no section and no request.
  "update|update-entry.jsx||1|1"
  "update-off|update-entry.jsx||0|1"
)

# The lane for iterating on a change: the fast, broad drivers. The full sweep
# stays the release gate.
QUICK_JOBS=(
  "boot|boot-entry.jsx||0|0"
  "list-grid|list-entry.jsx|?view=grid|0|0"
  "rail|rail-entry.jsx||0|0"
  "search|search-entry.jsx||0|0"
  "sections|sections-entry.jsx||0|0"
  "menu|menu-entry.jsx||0|0"
  "views|views-entry.jsx||0|0"
  "longpress|longpress-entry.jsx||0|0"
)

JOBS=("${FULL_JOBS[@]}")
[ "$MODE" = quick ] && JOBS=("${QUICK_JOBS[@]}")

run_one() {  # run_one <port> <name> <entry> [query] [update]
  local port=$1 name=$2 entry=$3 query=${4:-} update=${5:-0}
  ENTRY="scripts/harness/$entry" NAME="diff-$LABEL-$name" PORT="$port" QUERY="$query" \
    HARNESS_UPDATE_CHECK="$update" \
    "$HERE/run.sh" >"$OUT/$name.log" 2>&1
  if [ -f "/tmp/diff-$LABEL-$name/result.json" ]; then
    cp "/tmp/diff-$LABEL-$name/result.json" "$OUT/$name.json"
    local n
    n=$(python3 -c "import json;r=json.load(open('$OUT/$name.json'));print(f\"{sum(1 for x in r if x['pass'])}/{len(r)}\")")
    printf '%s\n' "$n" > "$OUT/$name.tally"
    # Green drivers give back their 50–160 MB as they finish; a red one keeps
    # its dir for post-mortem. `${n%%/*}` vs `${n##*/}` is "all passed".
    if [ "${n%%/*}" = "${n##*/}" ]; then rm -rf "/tmp/diff-$LABEL-$name"; fi
  else
    printf 'NO RESULTS\n' > "$OUT/$name.tally"
  fi
}
export -f run_one
export LABEL OUT HERE

# Each job gets its own port (index-based, so no two can collide) and its own
# NAME dir (run_one derives it). xargs keeps the pool at WORKERS processes.
dispatch_pool() {  # stdin: one name|entry|query|update line per job
  local idx=0 line
  while IFS= read -r line; do
    printf '%s|%s\n' "$idx" "$line"
    idx=$((idx + 1))
  done | xargs -r -P "$WORKERS" -I{} bash -c '
    IFS="|" read -r idx name entry query update <<< "$1"
    run_one $((8850 + idx)) "$name" "$entry" "$query" "$update"
  ' _ {}
}

cd "$ROOT" || exit 1
echo "── $LABEL ──"
if [ "${SKIP_LINT:-}" != "1" ]; then
  if npm run lint >"$OUT/lint.log" 2>&1; then
    echo "  lint: clean"
  else
    echo "  lint: FAILED — CI would not build this tree, so neither will this:"
    sed -n '1,20p' "$OUT/lint.log"
    exit 1
  fi
fi

PARALLEL=()
SERIAL=()
for job in "${JOBS[@]}"; do
  IFS='|' read -r name entry query update serial <<< "$job"
  if [ "$serial" = 1 ]; then SERIAL+=("$name|$entry|$query|$update")
  else PARALLEL+=("$name|$entry|$query|$update"); fi
done

if [ "${#PARALLEL[@]}" -gt 0 ]; then
  echo "  running ${#PARALLEL[@]} drivers, $WORKERS at a time"
  printf '%s\n' "${PARALLEL[@]}" | dispatch_pool
fi
for job in "${SERIAL[@]}"; do
  IFS='|' read -r name entry query update <<< "$job"
  run_one "$SERIAL_PORT" "$name" "$entry" "$query" "$update"
done

# A driver with no result file did not run at all — a missing observation, not
# a red check, and it must not read as a pass.
MISSING=0
for job in "${JOBS[@]}"; do
  name=${job%%|*}
  tally=$(cat "$OUT/$name.tally" 2>/dev/null || printf 'NO RESULTS')
  echo "  $name: $tally"
  [ "$tally" = "NO RESULTS" ] && MISSING=$((MISSING + 1))
done
echo "── $LABEL done ──"
if [ "$MISSING" -gt 0 ]; then
  echo "!! $MISSING driver(s) produced no results — the sweep did not cover them."
  exit 1
fi
