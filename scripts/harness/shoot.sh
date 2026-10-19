#!/usr/bin/env bash
# Captures the README screenshots from Test mode.
#
# One capture per screen: shot-entry.jsx builds the screen, then a hidden
# /hold.png keeps the page's load event pending until the driver says it is
# ready — see run.sh's SCREENSHOT branch and server.py's SHOT_READY. Firefox
# writes the PNG itself and exits, so there is no WebDriver in the path.
#
# Test mode, deliberately: the mock generators are deterministic and are the
# app's own demo content, so no frame of this script touches a real library.
#
# Every image is validated after capture. A screenshot that silently came out
# 1366x682 or blank is the failure mode this script exists to catch — the
# first version of the harness measured the wrong viewport for weeks and every
# check still passed.
#
# Usage: bash scripts/harness/shoot.sh [screen…]
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT="$ROOT/docs/screenshots"
PORT=${PORT:-8795}

SCREENS=("$@")
if [ ${#SCREENS[@]} -eq 0 ]; then
  SCREENS=(home performers performer-detail scene-detail settings-stats settings-server)
fi

mkdir -p "$OUT"
FAILED=0
for screen in "${SCREENS[@]}"; do
  echo "── $screen ──"
  SHOT="$OUT/$screen.png"
  if ! ENTRY=scripts/harness/shot-entry.jsx NAME="shot-$screen" PORT="$PORT" \
      QUERY="?screen=$screen" SCREENSHOT="$SHOT" \
      bash "$HERE/run.sh" >"/tmp/shot-$screen.log" 2>&1; then
    echo "  FAILED to capture — see /tmp/shot-$screen.log"
    tail -5 "/tmp/shot-$screen.log" | sed 's/^/    /'
    FAILED=1
    continue
  fi
  DIM=$(identify -format '%wx%h' "$SHOT" 2>/dev/null)
  SD=$(identify -format '%[standard-deviation]' "$SHOT" 2>/dev/null)
  # A blank stage has an SD near zero; real content is well above 1000 on a
  # 16-bit image. The number is a floor, not a fidelity check.
  if [ "$DIM" != '1920x1080' ]; then
    echo "  WRONG SIZE: $DIM (wanted 1920x1080)"
    FAILED=1
  elif awk "BEGIN{exit !($SD < 1000)}"; then
    echo "  LOOKS BLANK: standard-deviation $SD"
    FAILED=1
  else
    echo "  ok: $DIM  sd=$SD  $(du -h "$SHOT" | cut -f1)"
  fi
done

exit $FAILED
