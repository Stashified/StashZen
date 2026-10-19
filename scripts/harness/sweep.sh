#!/usr/bin/env bash
# Runs every driver and collects the result JSONs under /tmp/diff/$1/<name>.json,
# so two revisions can be compared byte-for-byte.
#
# The comparison this exists for is a *differential*: run it against two
# revisions and diff the result files. Which means the two rules its own
# history taught are worth stating before the driver list.
#
#   A differential proves neutrality. It never proves coverage. If a check is
#   red on both sides the diff is clean and the check is still red — which is
#   how the two strip views sat at 6/13 for their whole existence while every
#   sweep called it a pass. Read the tally on both sides, and name the checks
#   that are red on both.
#
#   Run it *before* any version bump. __APP_VERSION__ is interpolated into the
#   DOM by FirstRun.jsx and SettingsPanel.jsx, so bumping package.json partway
#   through changes firstrun, controls and actions-settings and reads as a
#   regression that is really a release note.
#
# One at a time, deliberately: concurrent runs are where this harness has hung.
#
#   Disk is a real failure mode. Each run leaves a Firefox profile and a bundle
#   under /tmp/diff-<label>-<name>, 50–160 MB apiece. Three rounds of leftovers
#   filled this machine's 7.5 GB tmpfs on 2026-10-17, and the symptom was not a
#   message: the driver whose server could not write result.json died, its
#   server stayed up, and the sweep hung on it while later drivers ran anyway.
#   Run dirs of *green* drivers are now deleted as they finish; a red driver
#   keeps its dir, because that is when its bundle and browser log matter.
#   `df -h /tmp` is the first thing to check when a sweep appears stuck.
#
#   Lint runs first, and aborts the sweep. This sweep is what gets run in place of
#   CI's build, and `npm run lint` is a step *of* that build — a lint error is a
#   release that never produces a .wgt. Until 0.11.0 nothing checked it here, and
#   an unused import in App.jsx reached CI and killed the release job while this
#   sweep sat at 477/477, because a lint error is not a driver and no driver can
#   see one. Abort rather than warn: a red line in a tally is a thing that gets
#   scrolled past, which is the failure this is closing. SKIP_LINT=1 escapes it
#   for the differential case, where lint on one side is not what is being
#   compared and the driver results are still wanted.
#
# Usage:  bash scripts/harness/sweep.sh <label>
set -u

LABEL=${1:?usage: sweep.sh <label>}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=/tmp/diff/$LABEL
mkdir -p "$OUT"
# Leftovers from an interrupted round of the same label. Safe because sweeps
# are run one at a time; never do this while one is in flight.
rm -rf /tmp/diff-"$LABEL"-*

# A driver with no result file did not run at all — that is not a red check, it
# is a missing observation, and it must not read as a pass. This happened for
# real: run.sh used to load the first *.js alphabetically, so boot-entry.jsx
# (whose dynamic imports make Rollup emit extra chunks) loaded a chunk that
# mounted nothing, printed NO RESULTS, and the sweep still exited 0.
MISSING=0

run() {  # run <name> <entry> [query]
  local name=$1 entry=$2 query=${3:-}
  ENTRY="scripts/harness/$entry" NAME="diff-$LABEL-$name" PORT=8850 QUERY="$query" \
    "$HERE/run.sh" >"$OUT/$name.log" 2>&1
  if [ -f "/tmp/diff-$LABEL-$name/result.json" ]; then
    cp "/tmp/diff-$LABEL-$name/result.json" "$OUT/$name.json"
    local n
    n=$(python3 -c "import json;r=json.load(open('$OUT/$name.json'));print(f\"{sum(1 for x in r if x['pass'])}/{len(r)}\")")
    echo "  $name: $n"
    # Green drivers give back their 50–160 MB as they finish; a red one keeps
    # its dir for post-mortem. `${n%%/*}` vs `${n##*/}` is "all passed".
    if [ "${n%%/*}" = "${n##*/}" ]; then rm -rf "/tmp/diff-$LABEL-$name"; fi
  else
    echo "  $name: NO RESULTS — the driver did not execute (see $OUT/$name.log)"
    MISSING=$((MISSING + 1))
  fi
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
run list-grid      list-entry.jsx      '?view=grid'
run list-carousel  list-entry.jsx      '?view=carousel'
run list-coverflow list-entry.jsx      '?view=coverflow'
# `?view=random` is kept, but it does not mean what its name says. RandomPage
# went in 0.7.0, so 'random' is not a key in VIEWS and the `|| VIEWS.grid`
# fallback renders VideoGrid — the same component as `list-grid`. It is NOT,
# however, a byte-duplicate of that config, which is the trap: runGrid's G6
# guard tests the raw query string (`VIEW !== 'grid'`) rather than the resolved
# view, so `random` takes the skip branch and reports 18 checks to grid's 19,
# with the two real race assertions replaced by one "skipped" line. A
# configuration that renders the grid and silently skips the grid's distinctive
# checks is worse than a duplicate, and it stays in the sweep with this note
# rather than being quietly dropped — the count is a baseline other runs are
# diffed against. The underlying driver inconsistency (three notions of "which
# view is under test": the query string, `V.kind`, and the VIEWS row) is real
# and unfixed; `list-entry.jsx`'s header says the `random` view "went with
# RandomPage", which is true of the page and not of this row.
run list-random    list-entry.jsx      '?view=random'
# The one-column List mode. Same paging contract as the grid, plus the shape
# assertions that distinguish a list from a four-column grid. Added in 0.17.0.
run list-list      list-entry.jsx      '?view=list'
run boot           boot-entry.jsx
run markerfix      markerfix-entry.jsx
# The focus-move paint contract of all four classic-grid cards. Structural,
# not a timing test: see the header of focuspaint-entry.jsx for why this
# harness cannot honestly time a TV paint.
run focuspaint     focuspaint-entry.jsx
# Left/Right walks every visual line of every screen in reading order. Eleven
# screens, both directions; see roworder-entry.jsx for the triaged exclusions
# (carousel/list are one shape each, dropdowns are one column) and for why the
# expected order is derived from rectangles rather than from the navigator.
run roworder       roworder-entry.jsx
run rail           rail-entry.jsx
# The four browse-only sections, and the two things only they exercise: a
# listing whose *content* has to be its own (S1 — the check that caught the
# reconciled-EntityPage bug on 2026-10-16, where all four sections drew the
# Tags tab's rows under their own prefixes), and an activation that switches
# tab while applying a filter.
run sections       sections-entry.jsx
# Home as the showroom, and the See-all hand-off into the listing tabs it
# points at. The one driver that lives on Home as its default surface since
# 0.15.0 split the scene listing out to Scenes.
run showroom       showroom-entry.jsx
# Leaving a tab is the TV's refresh: the arriving page must go to the wire
# rather than be served the module-scoped list cache. The report this pins:
# scenes added/removed on the server stayed invisible until the app was
# relaunched. Added in 0.22.1.
run refresh        refresh-entry.jsx
# Long-press and play-queue coverage used to be `menu` alone, which runs only
# the driver's default `keys` view. menu-entry.jsx has five runners
# (`?view=keys|menu|queue|saves|buttons`); the other four were reachable only
# by hand and had never been run by a sweep. The `saves` one was red when
# first swept: its assertion contradicted the completed-scene contract (see
# the note at S3 there). Registered separately so each view gets its own
# result file and its own diff line.
run menu           menu-entry.jsx
run menu-actions   menu-entry.jsx      '?view=menu'
run menu-queue     menu-entry.jsx      '?view=queue'
run menu-saves     menu-entry.jsx      '?view=saves'
run menu-buttons   menu-entry.jsx      '?view=buttons'
run preview        preview-entry.jsx
run codec          codec-entry.jsx
run controls       controls-entry.jsx
run detail         entry.jsx
# The performer detail page's one profile query: card-first paint, the adopted
# server values, the empty-field hiding and the failure path, all against a
# fixture designed to disagree with the card. Added in 0.19.0.
run performer      performer-entry.jsx
run filter         filter-entry.jsx
run firstrun       firstrun-entry.jsx
# The appearance theme: module-init application (a relaunch) and the Settings
# row's draft/Save contract. Added in 0.16.0.
run theme          theme-entry.jsx
run actions-settings actions-entry.jsx '?view=settings'
run actions-exit   actions-entry.jsx   '?view=exit'
# The two read-only Settings panels added in 0.20.0: library stats and server
# status. Each gets its own loading/ready/error path, a Test-mode branch and a
# fetch count, plus the two ordering traps the fake server can spring.
run settings-status settings-status-entry.jsx
# 0.23.0's data-layer fixes, where the observable is ordering/a cache slot/a
# key string rather than a screen: Test-mode sorts, the queue's page-boundary
# skip, listCache's in-flight identity, the source key's digest, and the
# folder picker. See datalayer-entry.jsx.
run datalayer      datalayer-entry.jsx
# 0.23.1's two recovery surfaces. ErrorBoundary replaces a black screen after
# a render throw; the PIN limiter puts a cost on repeated guesses. Both are
# self-contained drivers — see their headers.
run errorboundary  errorboundary-entry.jsx
run pinlock        pinlock-entry.jsx
run views          views-entry.jsx
echo "── $LABEL done ──"
if [ "$MISSING" -gt 0 ]; then
  echo "!! $MISSING driver(s) produced no results — the sweep did not cover them."
  exit 1
fi
