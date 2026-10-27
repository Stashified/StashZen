#!/usr/bin/env bash
# Runs a headless DOM harness driver against a fake Stash endpoint.
#
# Only the server is a stand-in: the real components, hooks, CSS modules and
# service layer all run, so `runQuery`, the query text and the normalisers are
# shipped code.
#
# Exit code 124 from Firefox is SUCCESS — it never exits on its own, so the
# `timeout` wrapper is what ends it. We wait for the DONE file instead.
#
# Overridable, so one runner serves every driver:
#   ENTRY  harness driver  (default scripts/harness/entry.jsx — SceneDetailPage)
#   NAME   scratch dir     (default detailverify → /tmp/$NAME/{dist,result.json})
#   PORT   listen port     (default 8791 — a second concurrent run needs its own)
#   QUERY  appended to the URL, for a driver that switches view (e.g. '?view=grid')
#   WINDOW firefox window size (default 1920,1080 — the TV's viewport)
#   SCREENSHOT  path to capture instead of collecting results. See shoot.sh.
set -u

REPO=$(cd "$(dirname "$0")/../.." && pwd)
ENTRY=${ENTRY:-scripts/harness/entry.jsx}
NAME=${NAME:-detailverify}
OUT=/tmp/$NAME/dist
PORT=${PORT:-8791}
QUERY=${QUERY:-}

# The window size is load-bearing, not cosmetic: the app has no fixed stage, so
# it lays out at whatever viewport it is given and the layout's shape changes
# with it. The left rail is the sharp case — its Settings row sits at the end of
# a flexible spacer, so whether the D-pad can reach it past a grid card depends
# on window height alone. Firefox's headless default is short enough that the
# card's 1.5-weighted horizontal penalty keeps the bug unreachable, so a driver
# at the wrong height passes on geometry rather than on the fix.
#
# Samsung's browser viewport on a 4K set is 1920x1080 CSS pixels (the panel is
# 3840x2160 at devicePixelRatio 2), and that is the default here.
WINDOW=${WINDOW:-1920,1080}
SCREENSHOT=${SCREENSHOT:-}
HARNESS="$REPO/scripts/harness"

rm -rf "$OUT" /tmp/$NAME/result.json /tmp/$NAME/DONE /tmp/$NAME/SHOT_OK
mkdir -p "$OUT"

echo "── building bundle ($ENTRY) ──"
cd "$REPO" || exit 1
HARNESS_ENTRY="$ENTRY" HARNESS_OUT="$OUT" \
  HARNESS_UPDATE_CHECK="${HARNESS_UPDATE_CHECK:-0}" \
  HARNESS_UPDATE_URL="${HARNESS_UPDATE_URL:-}" \
  npx vite build --config scripts/harness/vite.config.mjs 2>&1 | tail -5 || exit 1

CSS=$(ls "$OUT"/*.css 2>/dev/null | head -1 | xargs -r basename)
# The entry chunk has a fixed name (vite.config.mjs `fileName`) and must be the
# one the page loads: with dynamic imports Rollup emits extra chunks, and the
# alphabetically-first *.js (`App-…js`) mounts nothing and reports NO RESULTS.
JS=verify.js
[ -f "$OUT/$JS" ] || { echo "no bundle emitted ($JS missing)"; exit 1; }

# emptyOutDir wipes these on every rebuild, so regenerate rather than write
# them once by hand.
cat > "$OUT/index.html" <<HTML
<!doctype html>
<html><head><meta charset="utf-8"><title>verify</title>
${CSS:+<link rel="stylesheet" href="./$CSS">}
<script>window.__PORT__ = $PORT;</script>
</head><body><div id="root"></div>
$( [ -n "$SCREENSHOT" ] && echo '<img src="/hold.png" style="display:none" alt="">' )
<script type="module" src="./$JS"></script>
</body></html>
HTML

# A real, playable media file: `ended`, an advancing currentTime and the
# resume-save path are unreachable with a dead URL, and a save can write wrong
# data to the library rather than misdraw a screen. A silent 60s WAV: no codec
# to negotiate, and long enough not to end and race the assertions.
python3 - "$OUT/tone.wav" <<'PY'
import struct, sys, wave
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(1); w.setsampwidth(1); w.setframerate(8000)
    w.writeframes(b'\x80' * (8000 * 60))
PY

# Cover images are generated per scene by server.py (_png), not written here:
# they must differ per scene, and a file on disk cannot vary by who asked.

echo "── starting server on :$PORT ──"
python3 "$HARNESS/server.py" "$OUT" "$PORT" &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/" -o /dev/null && break
  sleep 0.25
done

echo "── running firefox ──"
PROFILE=/tmp/$NAME/profile
# Wiped between runs: a cached bundle replays a stale build and can reproduce
# an already-fixed failure.
rm -rf "$PROFILE"; mkdir -p "$PROFILE"
# Autoplay allowed explicitly. The player calls play() itself on mount, and
# Firefox's autoplay policy refuses that for media it considers audible — the
# playback half of the harness would silently do nothing without this.
cat > "$PROFILE/user.js" <<PREFS
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("media.autoplay.allow-muted", true);
PREFS
# How the viewport is set, measured with Firefox 157 by loading a page that
# reported window.innerWidth/innerHeight:
#
#   MOZ_HEADLESS_WIDTH/HEIGHT        ignored (the headless screen stays 1366x768)
#   browser.window.* in user.js      ignored (window comes up 1280x886)
#   --window-size=1920,1080          ignored for a normal load (1366x682)
#   --width=1920 --height=1080       1920x994 — the flag sizes the *window*
#   --width=1920 --height=1166       1920x1080 — the viewport, exactly
#
# Headless Firefox still reserves 86 CSS px of window chrome, so 86 is added to
# the requested viewport height — the one way measured to work.
CHROME_H=86
if [ -n "$SCREENSHOT" ]; then
  # Screenshot mode. `--screenshot` captures once the load event fires and then
  # exits — the hidden /hold.png in index.html ties that event to the driver's
  # readiness POST rather than to the first paint. The timeout is a safety net:
  # a stuck capture must not hang a release.
  mkdir -p "$(dirname "$SCREENSHOT")"
  rm -f "$SCREENSHOT"
  # `--window-size`, not `--width/--height`: measured on Firefox 157, the
  # latter are ignored by the screenshot path (1366x768, the headless default),
  # while --window-size is the size the captured image comes out at. The 86 px
  # of window chrome does not apply here — there is no window.
  timeout 60 firefox --headless --screenshot "$SCREENSHOT" \
    --window-size=$WINDOW \
    --no-remote --new-instance \
    -profile "$PROFILE" "http://127.0.0.1:$PORT/$QUERY" >>/tmp/$NAME/firefox.log 2>&1
  echo
  echo "── screenshot ──"
  if [ ! -f "/tmp/$NAME/SHOT_OK" ]; then
    echo "  SCREEN NOT READY — the driver never reached it (image discarded)"
    rm -f "$SCREENSHOT"
  elif [ -s "$SCREENSHOT" ]; then
    echo "  wrote $SCREENSHOT"
    exit 0
  fi
  echo "  capture failed — firefox.log tail:"
  tail -15 /tmp/$NAME/firefox.log
  exit 1
fi
firefox --headless --width=${WINDOW%,*} --height=$(( ${WINDOW#*,} + CHROME_H )) \
  --no-remote --new-instance \
  -profile "$PROFILE" "http://127.0.0.1:$PORT/$QUERY" >/tmp/$NAME/firefox.log 2>&1 &
FF=$!
# Firefox never exits on its own, so wait on the driver's DONE file rather than
# the process — the driver posts /result then /done, so DONE means the results
# are already on disk. This keeps a failing check from costing a fixed 90s.
for _ in $(seq 1 400); do
  [ -f "/tmp/$NAME/DONE" ] && break
  kill -0 "$FF" 2>/dev/null || break
  sleep 0.25
done
if [ -f "/tmp/$NAME/DONE" ]; then
  echo "  driver reported DONE"
else
  echo "  driver never reported DONE (100s) — killing firefox"
fi
kill "$FF" 2>/dev/null
wait "$FF" 2>/dev/null

if [ -f /tmp/$NAME/result.json ]; then
  echo
  echo "── results ──"
  python3 - "$NAME" <<'PY'
import json, sys
rows = json.load(open(f'/tmp/{sys.argv[1]}/result.json'))
passed = sum(1 for r in rows if r['pass'])
for r in rows:
    print(f"  {'PASS' if r['pass'] else 'FAIL'}  {r['name']}")
    if r['detail']:
        print(f"          {r['detail']}")
print(f"\n{passed}/{len(rows)} passed")
PY
else
  echo "NO RESULTS — firefox.log tail:"
  tail -25 /tmp/$NAME/firefox.log
fi
