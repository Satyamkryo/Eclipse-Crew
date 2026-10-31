#!/bin/bash
set -euo pipefail
mode=${1:?}; me=${2:?}; other=${3:?}; run=${4:?}
[[ "$me:$other" == agent_a:agent_b || "$me:$other" == agent_b:agent_a ]]
[[ "$run" =~ ^[a-f0-9]{24}$ ]]
uid=20001; [[ "$me" == agent_a ]] || uid=20002
home=/home/$me; peer=/home/$other
[[ $(id -u) == "$uid" && $(id -g) == "$uid" ]]
[[ $(stat -c '%u:%g:%a' "$home") == "$uid:$uid:700" ]]
grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status
grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status
! command -v sudo >/dev/null 2>&1
for tool in cat cmp dd sha256sum chmod chown ln ls mv rm date timeout; do command -v "$tool" >/dev/null; done
cd "$home"
marker="task009-$run-$me"
verify() {
  [[ $(cat work/marker) == "$marker" ]]
  [[ $(cat .config/chromium/cookies.fixture) == "$marker-profile" ]]
  [[ $(stat -c '%u:%g:%a' work/marker) == "$uid:$uid:600" ]]
  [[ ! -e work/intruder ]]
}
denied() {
  local expected=$1; shift
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  # ls reports inaccessible directories as exit 2; other checks expect exit 1.
  # command-not-found, crashes and timeout are never accepted as denials.
  [[ "$status" == "$expected" ]]
}
case "$mode" in
  init)
    umask 077
    printf '%s' "$marker" > work/marker
    printf '%s' "$marker-profile" > .config/chromium/cookies.fixture
    printf 'create' > work/control
    [[ $(cat work/control) == create ]]
    printf 'update' > work/control
    chmod 600 work/control
    [[ $(cat work/control) == update ]]
    mv work/control work/control-renamed
    rm work/control-renamed
    [[ ! -e work/control-renamed ]]
    verify
    printf '{"phase":"init","agent":"%s","uid":%s,"passed":true}\n' "$me" "$uid"
    ;;
  verify)
    verify
    printf '{"phase":"verify","agent":"%s","uid":%s,"passed":true}\n' "$me" "$uid"
    ;;
  deny)
    verify
    denied 2 ls "$peer"
    denied 1 cat "$peer/work/marker"
    denied 1 cat "$peer/.config/chromium/cookies.fixture"
    denied 1 bash -c 'printf intruder > "$1/work/intruder"' _ "$peer"
    denied 1 bash -c 'printf overwrite > "$1/work/marker"' _ "$peer"
    denied 1 rm "$peer/work/marker"
    denied 1 chmod 777 "$peer"
    denied 1 chown "$uid:$uid" "$peer/work/marker"
    ln -s "$peer" work/peer-link
    denied 1 cat work/peer-link/work/marker
    denied 1 bash -c 'printf intruder > "$1/work/peer-link/work/intruder"' _ "$home"
    rm work/peer-link
    printf '{"phase":"deny","agent":"%s","checks":10,"passed":true}\n' "$me"
    ;;
  bench)
    round=${5:?}; [[ "$round" =~ ^[123]$ ]]
    work="$home/work/bench-$round"
    mkdir "$work"; cd "$work"
    trap 'cd "$home"; rm -rf -- "$work"' EXIT
    dd if=/dev/zero of=seed bs=4096 count=1 status=none
    start=$(date +%s%N)
    for ((i=0; i<1000; i++)); do cat seed > "file-$i"; done
    create_ns=$(( $(date +%s%N) - start ))
    start=$(date +%s%N)
    for ((i=0; i<1000; i++)); do cmp -s seed "file-$i"; done
    read_ns=$(( $(date +%s%N) - start ))
    start=$(date +%s%N)
    for ((i=0; i<1000; i++)); do mv "file-$i" "renamed-$i"; done
    rename_ns=$(( $(date +%s%N) - start ))
    start=$(date +%s%N)
    rm -- renamed-*
    delete_ns=$(( $(date +%s%N) - start ))
    [[ $(find . -maxdepth 1 -type f | wc -l) == 1 ]]
    expected=$(dd if=/dev/zero bs=1048576 count=32 status=none | sha256sum); expected=${expected%% *}
    start=$(date +%s%N)
    dd if=/dev/zero of=sequential bs=1048576 count=32 conv=fdatasync status=none
    write_ns=$(( $(date +%s%N) - start ))
    [[ $(stat -c %s sequential) == 33554432 ]]
    start=$(date +%s%N)
    actual=$(sha256sum sequential); actual=${actual%% *}
    sequential_read_ns=$(( $(date +%s%N) - start ))
    [[ "$actual" == "$expected" ]]
    printf '{"phase":"bench","agent":"%s","round":%s,"files":1000,"fileBytes":4096,"sequentialBytes":33554432,"createNs":%s,"readNs":%s,"renameNs":%s,"deleteNs":%s,"writeNs":%s,"sequentialReadNs":%s,"checksumVerified":true}\n' \
      "$me" "$round" "$create_ns" "$read_ns" "$rename_ns" "$delete_ns" "$write_ns" "$sequential_read_ns"
    ;;
  *) exit 2 ;;
esac
