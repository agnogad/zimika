#!/usr/bin/env bash
# End-to-end check: Xvfb + local audio + real mpv playback through IPC.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
N=${DISPLAY_NUM:-57}
PORT=${TEST_PORT:-8766}
WORK=$(mktemp -d /tmp/zimika-test.XXXXXX)
mkdir -p "$WORK/home" "$WORK/cfg" "$WORK/media"
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=8 -c:a libmp3lame -b:a 64k \
  -y "$WORK/media/test.mp3" >/dev/null 2>&1
(cd "$WORK/media" && python3 -m http.server "$PORT" --bind 127.0.0.1 >"$WORK/http.log" 2>&1) &
SERVER=$!
Xvfb ":$N" -screen 0 1366x900x24 >/dev/null 2>&1 &
XV=$!
sleep 1.5
env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE DISPLAY=":$N" GDK_BACKEND=x11 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/cfg" ZIMIKA_SELFTEST=1 \
  "$ROOT/zig-out/bin/zimika" >"$WORK/app.log" 2>&1 &
APP=$!
sleep 14
kill $APP $SERVER $XV 2>/dev/null
pkill -f 'mpv --no-config' 2>/dev/null
grep -E 'ZIMIKA FULLTEST|CONSOLE JS ERROR|panic' "$WORK/app.log"
grep -q 'ZIMIKA FULLTEST PASS' "$WORK/app.log"
RESULT=$?
echo "workdir=$WORK"
exit $RESULT
