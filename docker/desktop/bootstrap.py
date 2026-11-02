#!/usr/bin/python3
"""Trusted setup only; no caller-selected root executable or shell evaluation."""
import ctypes
import errno
import hashlib
import json
import os
import platform
import re
import signal
import stat
import subprocess
import sys

BASE = "/opt/eclipse/desktop"
INITIAL = 0x2001C3
ADMIN = 0x1C3
PROFILE_HASH = "fa1e603f170044c931a103bfbe3bac6cfc6c935bdc72408e01c4cf6425cde627"
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1", "DESKTOP_CONTROL_SECRET": os.environ.get("DESKTOP_CONTROL_SECRET", ""), "EGRESS_DESKTOP_SECRET": os.environ.get("EGRESS_DESKTOP_SECRET", ""), **({"ECLIPSE_FIXTURES": "1"} if os.environ.get("ECLIPSE_FIXTURES") == "1" else {})}


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def status():
    with open("/proc/self/status", encoding="ascii") as source:
        return dict(line.split(":", 1) for line in source if ":" in line)


def run(args):
    result = subprocess.run(args, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False)
    require(result.returncode == 0, "setup_command_failed")
    return result.stdout


def directory(name, mode):
    try:
        os.mkdir(name, mode)
        os.chmod(name, mode)
    except FileExistsError:
        pass
    value = os.lstat(name)
    require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0 and value.st_gid == 0 and stat.S_IMODE(value.st_mode) == mode, "unsafe_setup_directory")


def mount_records():
    with open("/proc/self/mountinfo", encoding="ascii") as source:
        rows = []
        for line in source:
            fields = line.split()
            if len(fields) > 6:
                rows.append((fields[3], fields[4], set(fields[5].split(","))))
        return rows


def mounted(target, flags):
    rows = [row for row in mount_records() if row[1] == target]
    require(len(rows) == 1 and flags <= rows[0][2], "unsafe_mount_state")
    return rows[0]


def setup():
    workspace = mounted("/workspace", {"rw"})
    require(re.search(r"/volumes/[A-Za-z0-9_.-]+/_data$", workspace[0]) is not None, "workspace_not_managed_volume")
    require(not stat.S_ISLNK(os.lstat("/workspace").st_mode), "workspace_not_managed_volume")
    directory("/workspace/.system", 0o700)
    directory("/workspace/.system/downloads", 0o755)
    directory("/workspace/homes", 0o755)
    directory("/run/eclipse", 0o700)
    directory("/tmp/.X11-unix", 0o1777)
    run(["mount", "--bind", "/workspace/.system/downloads", "/downloads"])
    run(["mount", "-o", "remount,bind,noexec,nosuid,nodev", "/downloads"])
    mounted("/downloads", {"rw", "noexec", "nosuid", "nodev"})
    run(["/usr/local/bin/node", BASE + "/agent-admin.mjs", "--restore"])
    for name in ("passwd", "group"):
        run(["mount", "--bind", "/run/eclipse/" + name, "/etc/" + name])
        run(["mount", "-o", "remount,bind,ro,nosuid,nodev,noexec", "/etc/" + name])
        mounted("/etc/" + name, {"ro", "nosuid", "nodev", "noexec"})


def verify_setup():
    directory("/workspace/.system", 0o700)
    directory("/workspace/homes", 0o755)
    directory("/run/eclipse", 0o700)
    mounted("/downloads", {"rw", "noexec", "nosuid", "nodev"})
    for name in ("passwd", "group"):
        mounted("/etc/" + name, {"ro"})
        require(os.stat("/etc/" + name).st_ino == os.stat("/run/eclipse/" + name).st_ino, "unsafe_identity_view")
    ready = os.lstat("/run/eclipse/ready.json")
    require(stat.S_ISREG(ready.st_mode) and ready.st_uid == 0 and stat.S_IMODE(ready.st_mode) == 0o600, "supervisor_not_ready")


class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]


class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint), ("pid", ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint), ("permitted", ctypes.c_uint), ("inheritable", ctypes.c_uint)]


def reduce_privileges():
    libc = ctypes.CDLL(None, use_errno=True)
    # x86-64 only; reject i386/x32 syscall ABI bypasses before the deny rules.
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x00050000 | errno.ENOSYS)]
    # All extra privileged calls in the pinned profile's SYS_ADMIN group,
    # except clone/setns/unshare required by Chromium, plus newer mount APIs.
    denied = [103, 165, 166, 170, 171, 179, 212, 298, 300, 303, 321, 428, 429, 430, 431, 432, 433, 442]
    for number in denied:
        instructions.extend([(0x15, 0, 1, number), (0x06, 0, 0, 0x00050000 | errno.EPERM)])
    instructions.append((0x06, 0, 0, 0x7FFF0000))
    filters = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    program = Program(len(instructions), filters)
    require(libc.prctl(38, 1, 0, 0, 0) == 0, "no_new_privileges_failed")
    require(libc.prctl(22, 2, ctypes.byref(program), 0, 0) == 0, "post_setup_filter_failed")
    require(libc.prctl(24, 21, 0, 0, 0) == 0, "bounding_drop_failed")
    header = CapHeader(0x20080522, 0)
    values = (CapData * 2)(CapData(ADMIN, ADMIN, 0), CapData(0, 0, 0))
    require(libc.capset(ctypes.byref(header), values) == 0, "capability_drop_failed")
    current = status()
    require(all(int(current[field].strip(), 16) == ADMIN for field in ("CapEff", "CapPrm", "CapBnd")), "capability_drop_failed")
    require(all(int(current[field].strip(), 16) == 0 for field in ("CapInh", "CapAmb")), "capability_drop_failed")
    require(int(current.get("Seccomp_filters", "0")) >= 2, "post_setup_filter_failed")


def main():
    os.umask(0o077)
    require(platform.machine() == "x86_64" and os.getuid() == 0 and os.getgid() == 0, "setup_identity_invalid")
    current = status()
    require(all(int(current[field].strip(), 16) == INITIAL for field in ("CapEff", "CapPrm", "CapBnd")) and current["NoNewPrivs"].strip() == "1", "setup_capabilities_invalid")
    with open(BASE + "/seccomp_profile.json", "rb") as source:
        require(hashlib.sha256(source.read().replace(b"\r\n", b"\n")).hexdigest() == PROFILE_HASH, "profile_pin_invalid")
    args = sys.argv[1:]
    if args:
        require(args[0] == "--admin" and len(args) >= 2 and args[1] in ("create", "inspect", "exec", "health", "session-start", "session-status", "session-stop", "session-fixture", "session-fixture-cookie"), "invalid_admin_command")
        verify_setup()
        reduce_privileges()
        os.execve("/usr/local/bin/node", ["node", BASE + "/agent-admin.mjs"] + args[1:], ENV)
    require(os.getpid() == 1, "bootstrap_requires_pid_one")
    setup()
    reduce_privileges()
    child = subprocess.Popen(["/usr/local/bin/node", BASE + "/supervisor.mjs"], env=ENV, start_new_session=True)
    def terminate(_number, _frame):
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    while True:
        try:
            pid, code = os.waitpid(-1, 0)
            if pid == child.pid:
                return os.waitstatus_to_exitcode(code)
        except InterruptedError:
            continue
        except ChildProcessError:
            return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        allowed = {"setup_command_failed", "unsafe_setup_directory", "unsafe_mount_state", "workspace_not_managed_volume", "unsafe_identity_view",
                   "supervisor_not_ready", "no_new_privileges_failed", "post_setup_filter_failed", "bounding_drop_failed", "capability_drop_failed",
                   "setup_identity_invalid", "setup_capabilities_invalid", "profile_pin_invalid", "invalid_admin_command", "bootstrap_requires_pid_one"}
        reason = str(error) if str(error) in allowed else "setup_refused"
        print(json.dumps({"outcome": "bootstrap_refused", "reason": reason}), file=sys.stderr)
        sys.exit(1)
