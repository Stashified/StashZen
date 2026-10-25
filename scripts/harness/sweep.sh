#!/usr/bin/env bash
# Runs every driver and collects the result JSONs under /tmp/diff/$1/<name>.json,
# so two revisions can be compared byte-for-byte.
#
# The comparison is a *differential*: run it against two revisions and diff the
# result files. Two rules follow from that.
#
#   A differential proves neutrality, never coverage. A check red on both sides
#   leaves a clean diff and is still red — read the tally on both sides and name
#   the checks red in both.
#
#   Run it *before* any version bump. __APP_VERSION__ is interpolated into the
#   DOM by FirstRun.jsx and SettingsPanel.jsx, so bumping package.json partway
#   changes firstrun, controls and actions-settings and reads as a regression.
#
# One at a time, deliberately: concurrent runs are where this harness has hung.
#
#   Disk is a real failure mode. Each run leaves a Firefox profile and a bundle
#   under /tmp/diff-<label>-<name>, 50–160 MB apiece. When the tmpfs fills, a
#   driver whose server cannot write result.json dies but its server stays up,
#   and the sweep hangs while later drivers run on. Green drivers delete their
#   dir; a red one keeps it for post-mortem. `df -h /tmp` when stuck.
#
#   Lint runs first and aborts the sweep: this sweep stands in for CI's build,
#   and `npm run lint` is a step *of* that build, so a lint error is a release
#   that never produces a .wgt and no driver can see it. Abort rather than warn,
#   because a red line in a tally gets scrolled past. SKIP_LINT=1 escapes it.
#
# Usage:  bash scripts/harness/sweep.sh <label>
set -u

LABEL=${1:?usage: sweep.sh <label>}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=/tmp/diff/$LABEL
mkdir -p "$OUT"
# Leftovers from an interrupted round of the same label. Safe because sweeps
# are run one at a time; never while one is in flight.
rm -rf /tmp/diff-"$LABEL"-*

# A driver with no result file did not run at all — a missing observation, not
# a red check, and it must not read as a pass. So it is counted and the sweep
# exits non-zero.
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
# `?view=random` does not mean what it says: 'random' is not a key in VIEWS, so
# the `|| VIEWS.grid` fallback renders the same VideoGrid as `list-grid`. It is
# not a byte-duplicate, though: runGrid's G6 guard tests the raw query string, so
# `random` takes the skip branch and reports 18 checks to grid's 19, with the
# race assertions replaced by a "skipped" line. It stays, with this note, because
# its count is a baseline other runs are diffed against.
run list-random    list-entry.jsx      '?view=random'
# The one-column List mode: the grid's paging contract plus the shape
# assertions that distinguish it from a four-column grid.
run list-list      list-entry.jsx      '?view=list'
run boot           boot-entry.jsx
run markerfix      markerfix-entry.jsx
# The focus-move paint contract of all four classic-grid cards. Structural,
# not a timing test: see the header of focuspaint-entry.jsx for why this
# harness cannot honestly time a TV paint.
run focuspaint     focuspaint-entry.jsx
# Left/Right walks every visual line of every screen in reading order, both
# directions; see roworder-entry.jsx for the triaged exclusions (carousel/list
# are one shape each, dropdowns are one column) and why the expected order is
# derived from rectangles rather than from the navigator.
run roworder       roworder-entry.jsx
run rail           rail-entry.jsx
# The four browse-only sections, and the two things only they exercise: a
# listing whose *content* has to be its own (S1 — each section must not draw
# another tab's rows under its own prefix), and an activation that switches tab
# while applying a filter.
run sections       sections-entry.jsx
# Home as the showroom, and the See-all hand-off into the listing tabs it points
# at. The one driver that lives on Home since the scene listing split out to
# Scenes.
run showroom       showroom-entry.jsx
# Leaving a tab is the TV's refresh: the arriving page must go to the wire
# rather than be served the module-scoped list cache, or server-side changes
# stay invisible until relaunch.
run refresh        refresh-entry.jsx
# Long-press and play-queue coverage. menu-entry.jsx has five runners
# (`?view=keys|menu|queue|saves|buttons`); registering each separately gives it
# its own result file and diff line, so a red view cannot hide behind a green
# default. The `saves` view's assertion must match the completed-scene contract
# (see the note at S3 there).
run menu           menu-entry.jsx
run menu-actions   menu-entry.jsx      '?view=menu'
run menu-queue     menu-entry.jsx      '?view=queue'
run menu-saves     menu-entry.jsx      '?view=saves'
run menu-buttons   menu-entry.jsx      '?view=buttons'
run preview        preview-entry.jsx
run codec          codec-entry.jsx
# The TV engine, with a fake AVPlay that records calls and has no picture. It
# asserts the decisions around the engine — which URL opens, that no <video>
# exists while the plane is up, the page's compositing, skims, hide/restore,
# content fallback, the format cache, HLS-before-MP4 and the session kill
# switch. It cannot assert that AVPlay decodes anything; that is the TV pass.
run avplay         avplay-entry.jsx
run controls       controls-entry.jsx
run detail         entry.jsx
# The performer detail page's one profile query: card-first paint, the adopted
# server values, the empty-field hiding and the failure path, against a fixture
# designed to disagree with the card.
run performer      performer-entry.jsx
# Back while the player is open over the performer page. The page's Back handler
# and the player's are sibling window-capture listeners; the page's focus-only
# guard cannot see a player that leaves focus on <body>, so one press closes
# both.
run performerback  performerback-entry.jsx
run filter         filter-entry.jsx
run firstrun       firstrun-entry.jsx
# The appearance theme: module-init application (a relaunch) and the Settings
# row's draft/Save contract.
run theme          theme-entry.jsx
run actions-settings actions-entry.jsx '?view=settings'
run actions-exit   actions-entry.jsx   '?view=exit'
# The two read-only Settings panels: library stats and server status. Each gets
# its own loading/ready/error path, a Test-mode branch and a fetch count, plus
# the two ordering traps the fake server can spring.
run settings-status settings-status-entry.jsx
# The data-layer fixes, where the observable is ordering/a cache slot/a key
# string rather than a screen: Test-mode sorts, the queue's page-boundary skip,
# listCache's in-flight identity, the source key's digest, and the folder
# picker. See datalayer-entry.jsx.
run datalayer      datalayer-entry.jsx
# The two recovery surfaces. ErrorBoundary replaces a black screen after a
# render throw; the PIN limiter puts a cost on repeated guesses. Both are
# self-contained drivers — see their headers.
run errorboundary  errorboundary-entry.jsx
run pinlock        pinlock-entry.jsx
run views          views-entry.jsx
# The long-press menus for Markers, Images and Galleries, and the slideshow
# entries they open. A gallery's pictures are served only when this driver asks
# for them (`/mode galleryImages=populate`) — the default empty answer is what
# Sections S6 depends on.
run longpress      longpress-entry.jsx
echo "── $LABEL done ──"
if [ "$MISSING" -gt 0 ]; then
  echo "!! $MISSING driver(s) produced no results — the sweep did not cover them."
  exit 1
fi
