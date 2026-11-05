#!/bin/sh
# Raise the managed browser for this session. Identity comes from the kernel and the
# worker-written PID file, never from a window title or caller text.
set -eu
# Fixed text only. Starting the browser stays with the owner's Start browser control so the
# app's pause, crew and security gates are never bypassed from inside the desktop.
stopped() {
  xmessage -center -timeout 8 -buttons OK:0 \
    "The browser is not running. Use Start browser in the Eclipse Crew desktop panel." >/dev/null 2>&1 &
  exit 1
}
pid_file="${XDG_RUNTIME_DIR:?}/browser.pid"
[ -f "$pid_file" ] || stopped
pid="$(cat "$pid_file")"
case "$pid" in ''|*[!0-9]*) stopped;; esac
owner="$(sed -n 's/^Uid:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "/proc/$pid/status" 2>/dev/null || true)"
[ "$owner" = "$(id -u)" ] || stopped
profile="${HOME:?}/.config/chrome-for-testing"
# Chromium re-execs with the whole command line packed into argv[0], so match the joined text.
command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
printf '%s\n' "$command" | grep -Fq -- "--user-data-dir=$profile" || stopped
# The PID also owns an unmapped helper window, and a minimized (iconic) browser is not
# "visible", so pick the window the window manager manages (it carries WM_STATE).
window=""
for candidate in $(xdotool search --pid "$pid" 2>/dev/null || true); do
  if xprop -id "$candidate" WM_STATE 2>/dev/null | grep -q 'window state'; then window="$candidate"; break; fi
done
[ -n "$window" ] || stopped
xdotool windowactivate --sync "$window" 2>/dev/null || xdotool windowactivate "$window"
xdotool windowraise "$window"
