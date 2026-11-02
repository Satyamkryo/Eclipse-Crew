#!/usr/bin/env python3
"""TASK-071. Put one agent process in a private user+network namespace, then exec it.

Usage: netns-enter.py --agent-dir <path> -- <command> [args...]
The caller has already dropped to the agent uid with setpriv (zero capabilities, no-new-privs).
Inside the new user namespace the same uid/gid are mapped to themselves, so identity checks keep working;
the namespace-local capabilities are dropped before exec, and only `lo` exists.
"""
import ctypes
import fcntl
import os
import socket
import stat as stat_module
import struct
import sys

CLONE_NEWUSER = 0x10000000
CLONE_NEWNET = 0x40000000
PR_CAPBSET_DROP = 24
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_CLEAR_ALL = 4
PR_SET_NO_NEW_PRIVS = 38
SIOCGIFFLAGS = 0x8913
SIOCSIFFLAGS = 0x8914
IFF_UP = 0x1
CAP_LAST = 63


def fail(code):
    sys.stderr.write(code + "\n")
    os._exit(111)


def status_fields():
    fields = {}
    with open("/proc/self/status", "r", encoding="ascii") as handle:
        for line in handle:
            name, _, value = line.partition(":")
            if name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp"):
                fields[name] = value.strip()
    return fields


def zero_capabilities(fields):
    for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
        try:
            if int(fields.get(name, "0"), 16) != 0:
                return False
        except ValueError:
            return False
    return True


def ifreq(name, flags):
    return struct.pack("16sH", name, flags) + b"\0" * 22


def bring_loopback_up():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, 0)
    try:
        current = struct.unpack("16sH", fcntl.ioctl(sock.fileno(), SIOCGIFFLAGS, ifreq(b"lo", 0))[:18])[1]
        fcntl.ioctl(sock.fileno(), SIOCSIFFLAGS, ifreq(b"lo", current | IFF_UP))
    finally:
        sock.close()


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]


def drop_capabilities(libc):
    for cap in range(0, CAP_LAST + 1):
        libc.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)
    libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)
    header = CapHeader(0x20080522, 0)
    data = (CapData * 2)()
    if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
        fail("netns_capset_failed")


def main():
    args = sys.argv[1:]
    agent_dir = None
    if args[:1] == ["--agent-dir"]:
        if len(args) < 2:
            fail("netns_invalid_arguments")
        agent_dir, args = args[1], args[2:]
    if args[:1] != ["--"] or len(args) < 2:
        fail("netns_invalid_arguments")
    command = args[1:]

    uid, gid = os.getuid(), os.getgid()
    if uid == 0 or uid != gid:
        fail("netns_identity_invalid")
    if set(os.getgroups()) - {gid}:
        fail("netns_identity_invalid")
    fields = status_fields()
    if not zero_capabilities(fields):
        fail("netns_capabilities_invalid")
    if fields.get("NoNewPrivs") != "1":
        fail("netns_security_invalid")
    if agent_dir is not None:
        try:
            agent_stat = os.lstat(agent_dir)
        except OSError:
            fail("netns_directory_invalid")
        if not stat_module.S_ISDIR(agent_stat.st_mode) or agent_stat.st_uid != uid or (agent_stat.st_mode & 0o7777) != 0o700:
            fail("netns_directory_invalid")

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(CLONE_NEWUSER) != 0:
        fail("netns_userns_failed")
    try:
        with open("/proc/self/setgroups", "w", encoding="ascii") as handle:
            handle.write("deny")
        with open("/proc/self/uid_map", "w", encoding="ascii") as handle:
            handle.write("%d %d 1" % (uid, uid))
        with open("/proc/self/gid_map", "w", encoding="ascii") as handle:
            handle.write("%d %d 1" % (gid, gid))
    except OSError:
        fail("netns_map_failed")
    if libc.unshare(CLONE_NEWNET) != 0:
        fail("netns_netns_failed")
    try:
        bring_loopback_up()
    except OSError:
        fail("netns_loopback_failed")
    drop_capabilities(libc)
    libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    if not zero_capabilities(status_fields()):
        fail("netns_capabilities_invalid")
    try:
        os.execvp(command[0], command)
    except OSError:
        fail("netns_exec_failed")


if __name__ == "__main__":
    main()
