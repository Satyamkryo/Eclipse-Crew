#!/bin/sh
set -eu
cd "${HOME:?}/work"
export TERM=xterm-256color
exec xterm -title "Terminal" -e /bin/bash
