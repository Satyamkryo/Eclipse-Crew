#!/bin/sh
# Raise the managed browser for this session. Identity comes from the kernel and the
# worker-written PID file, never from a window title or caller text.
set -eu
pid_file="${XDG_RUNTIME_DIR:?}/browser.pid"
[ -f "$pid_file" ] || exit 1
pid="$(cat "$pid_file")"
case "$pid" in ''|*[!0-9]*) exit 1;; esac
owner="$(sed -n 's/^Uid:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "/proc/$pid/status" 2>/dev/null || true)"
[ "$owner" = "$(id -u)" ] || exit 1
profile="${HOME:?}/.config/chrome-for-testing"
# Chromium re-execs with the whole command line packed into argv[0], so match the joined text.
command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
printf '%s\n' "$command" | grep -Fq -- "--user-data-dir=$profile" || exit 1
window="$(xdotool search --pid "$pid" --onlyvisible 2>/dev/null | head -n 1)"
[ -n "$window" ] || exit 1
xdotool windowactivate --sync "$window" 2>/dev/null || xdotool windowactivate "$window"
xdotool windowraise "$window"
