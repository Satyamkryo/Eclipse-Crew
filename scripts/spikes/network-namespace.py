"""Disposable TASK-071 probes; never used by the production entry point."""
import ctypes
import errno
import fcntl
import hashlib
import http.client
import http.server
import importlib.util
import ipaddress
import json
import os
import pathlib
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import urllib.parse

BASE = "/opt/eclipse/desktop"
SELF = "/opt/eclipse/network-namespace.py"
CAPS = ("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd")
OWNER = "07100000-0000-4000-8000-000000000000"
AGENTS = ["07100000-0000-4000-8000-000000000001", "07100000-0000-4000-8000-000000000002"]
GROUPS = ["private_localhost", "direct_egress", "unix_sockets", "fixed_bridge", "chromium"]
HTML = b'<html><body><button id="go" onclick="this.textContent=\'clicked\'">Click</button></body></html>'


def identity():
    rows = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
    result = {key: rows[key].strip() for key in (*CAPS, "NoNewPrivs", "Seccomp", "Seccomp_filters")}
    result.update(uid=os.getuid(), gid=os.getgid(), groups=os.getgroups(),
                  uid_map=pathlib.Path("/proc/self/uid_map").read_text().strip(),
                  gid_map=pathlib.Path("/proc/self/gid_map").read_text().strip(),
                  net=os.readlink("/proc/self/ns/net"), user=os.readlink("/proc/self/ns/user"))
    return result


def check(name, ok, **evidence):
    return {"name": name, "status": "pass" if ok else "fail", "evidence": evidence}


def call(args):
    result = subprocess.run(args, capture_output=True, timeout=25, check=False,
                            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"})
    if result.returncode:
        raise RuntimeError("setup_command_failed")
    return result.stdout


def bridge_reply(message, expected):
    # The caller cannot choose an upstream address or switch its trusted identity.
    if not isinstance(message, dict) or set(message) != {"agent", "url"} or message["agent"] != expected:
        return {"status": 403, "reason": "identity_refused"}
    try:
        target = urllib.parse.urlsplit(message["url"])
        if target.scheme != "http" or target.hostname != "fixture.test" or target.port not in (None, 80) or target.username or target.password or target.fragment:
            return {"status": 403, "reason": "destination_refused"}
        # A deterministic forbidden-DNS fixture, without querying real metadata/LAN.
        address = "169.254.169.254" if target.path == "/forbidden-dns" else "93.184.216.34"
        if not ipaddress.ip_address(address).is_global:
            return {"status": 403, "reason": "resolved_address_refused"}
        if target.path not in ("/", "/redirect") or target.query:
            return {"status": 403, "reason": "path_refused"}
        connection = http.client.HTTPConnection("127.0.0.1", 18080, timeout=2)
        try:
            connection.request("GET", target.path)
            response = connection.getresponse()
            body = response.read(8193)
            if 300 <= response.status < 400:
                return {"status": 403, "reason": "redirect_refused"}
            if len(body) > 8192:
                return {"status": 502, "reason": "response_limit"}
            return {"status": response.status, "body": body.decode("ascii")}
        finally:
            connection.close()
    except (ValueError, TypeError, OSError, http.client.HTTPException):
        return {"status": 403, "reason": "invalid_target"}


def serve_bridge(channel, expected):
    with channel, channel.makefile("rwb", buffering=0) as stream:
        while True:
            line = stream.readline(4097)
            if not line:
                return
            if len(line) > 4096:
                return
            try:
                response = bridge_reply(json.loads(line), expected)
            except (ValueError, TypeError):
                response = {"status": 403, "reason": "invalid_frame"}
            stream.write(json.dumps(response).encode() + b"\n")


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302 if self.path == "/redirect" else 200)
        if self.path == "/redirect":
            self.send_header("Location", "http://169.254.169.254/")
        self.end_headers()
        self.wfile.write(HTML)

    def log_message(self, *_args):
        pass


def server(handler, port):
    instance = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=instance.serve_forever, daemon=True).start()
    return instance


def connect_result(family, kind, address):
    with socket.socket(family, kind) as client:
        client.settimeout(0.4)
        try:
            client.connect(address)
            if kind == socket.SOCK_DGRAM:
                client.send(b"fixture")
            return "connected"
        except OSError as error:
            return errno.errorcode.get(error.errno, "timeout")


def drop_local_caps():
    libc = ctypes.CDLL(None, use_errno=True)
    # Bounding drops require namespace-local SETPCAP, so perform them before capset.
    for number in range(41):
        if libc.prctl(24, number, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "bounding_drop")
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint), ("pid", ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint), ("permitted", ctypes.c_uint), ("inheritable", ctypes.c_uint)]
    header = Header(0x20080522, 0)
    values = (Data * 2)()
    if libc.capset(ctypes.byref(header), values) != 0:
        raise OSError(ctypes.get_errno(), "capset")


def child(record, bridge_fd):
    result = {"agent": record["agentId"], "checks": [], "outer": identity()}
    try:
        assert all(int(result["outer"][key], 16) == 0 for key in CAPS)
        assert result["outer"]["NoNewPrivs"] == "1" and int(result["outer"]["Seccomp_filters"]) >= 2
        result["checks"].append(check("agent_outer_privileges", True))
        libc = ctypes.CDLL(None, use_errno=True)
        denied = libc.unshare(0x40000000)
        result["checks"].append(check("outer_network_namespace_requires_privilege", denied != 0 and ctypes.get_errno() == errno.EPERM))
        assert denied != 0
        stage = "unshare_user"
        if libc.unshare(0x10000000) != 0:
            raise OSError(ctypes.get_errno(), stage)
        pathlib.Path("/proc/self/setgroups").write_text("deny")
        pathlib.Path("/proc/self/uid_map").write_text(f'{record["uid"]} {record["uid"]} 1\n')
        pathlib.Path("/proc/self/gid_map").write_text(f'{record["gid"]} {record["gid"]} 1\n')
        stage = "unshare_network"
        if libc.unshare(0x40000000) != 0:
            raise OSError(ctypes.get_errno(), stage)
        result["namespace_setup"] = identity()
        stage = "enable_loopback"
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as interface:
            fcntl.ioctl(interface.fileno(), 0x8914, struct.pack("16sH14s", b"lo", 0x49, b""))
        stage = "drop_namespace_caps"
        drop_local_caps()
        result["inner"] = identity()
        assert all(int(result["inner"][key], 16) == 0 for key in CAPS)
        result["checks"].append(check("private_namespace_created", result["outer"]["net"] != result["inner"]["net"]))
    except (OSError, AssertionError) as error:
        result["checks"].append({"name": "private_namespace_created", "status": "fail", "evidence": {
            "stage": locals().get("stage", "outer_identity"), "errno": errno.errorcode.get(getattr(error, "errno", None), "identity_mismatch")}})
        result["checks"].extend({"name": name, "status": "blocked", "reason": "namespace_prerequisite_failed"} for name in GROUPS)
        print(json.dumps(result), flush=True)
        return

    bridge = socket.socket(fileno=bridge_fd)
    stream = bridge.makefile("rwb", buffering=0)
    lock = threading.Lock()
    inherited = []
    for descriptor in os.listdir("/proc/self/fd"):
        try:
            fd = int(descriptor)
            if stat.S_ISSOCK(os.fstat(fd).st_mode):
                with socket.socket(fileno=os.dup(fd)) as candidate:
                    inherited.append({"fd": fd, "family": int(candidate.family)})
        except OSError:
            continue
    result["checks"].append(check("inherited_socket_boundary", inherited == [{"fd": bridge_fd, "family": int(socket.AF_UNIX)}], sockets=inherited))

    def forward(url, agent=None):
        with lock:
            stream.write(json.dumps({"agent": agent or record["agentId"], "url": url}).encode() + b"\n")
            return json.loads(stream.readline(16385))

    class Local(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            response = forward("http://fixture.test" + self.path)
            self.send_response(response["status"])
            self.end_headers()
            self.wfile.write(response.get("body", "denied").encode())

        def log_message(self, *_args):
            pass

    class Marker(Local):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(record["agentId"].encode())

    proxy = server(Local, 18081)
    marker = server(Marker, 18082)
    connection = http.client.HTTPConnection("127.0.0.1", 18082, timeout=2)
    connection.request("GET", "/")
    seen = connection.getresponse().read().decode()
    connection.close()
    result["checks"].append(check("private_localhost", seen == record["agentId"], marker=seen, port=18082))
    paths = [("shared_loopback", socket.AF_INET, socket.SOCK_STREAM, ("127.0.0.1", 18080)),
             ("shared_ipv6_loopback", socket.AF_INET6, socket.SOCK_STREAM, ("::1", 18080)),
             ("controller_loopback", socket.AF_INET, socket.SOCK_STREAM, ("127.0.0.1", 4310)),
             ("direct_tcp", socket.AF_INET, socket.SOCK_STREAM, ("192.0.2.1", 80)),
             ("direct_dns_udp", socket.AF_INET, socket.SOCK_DGRAM, ("192.0.2.1", 53)),
             ("direct_quic_udp", socket.AF_INET, socket.SOCK_DGRAM, ("192.0.2.1", 443)),
             ("direct_ipv6", socket.AF_INET6, socket.SOCK_STREAM, ("2001:db8::1", 443))]
    for name, family, kind, address in paths:
        observed = connect_result(family, kind, address)
        result["checks"].append(check(name, observed != "connected", result=observed))
    route4 = pathlib.Path("/proc/net/route").read_text().splitlines()[1:]
    interfaces = [name for _index, name in socket.if_nameindex()]
    result["checks"].append(check("no_outer_interface_or_route", not route4 and interfaces == ["lo"], interfaces=interfaces, ipv4_route_count=len(route4)))
    # Deliberately reachable pathname socket exposes the distinction between network
    # namespaces and filesystem permissions; record it as a production blocker.
    for name, address in [("pathname_socket_boundary", "/tmp/task071-shared.sock"),
                          ("abstract_socket_boundary", "\0task071-shared"),
                          ("protected_socket_boundary", "/run/eclipse/task071-private.sock")]:
        observed = connect_result(socket.AF_UNIX, socket.SOCK_STREAM, address)
        result["checks"].append(check(name, observed != "connected", result=observed))
    bridge_cases = [("bridge_allowed", "http://fixture.test/", None, 200),
                    ("bridge_unlisted", "http://unlisted.test/", None, 403),
                    ("bridge_private", "http://127.0.0.1/", None, 403),
                    ("bridge_metadata", "http://169.254.169.254/", None, 403),
                    ("bridge_forbidden_dns", "http://fixture.test/forbidden-dns", None, 403),
                    ("bridge_redirect", "http://fixture.test/redirect", None, 403),
                    ("bridge_forged_identity", "http://fixture.test/", "peer", 403)]
    for name, url, agent, expected in bridge_cases:
        response = forward(url, agent)
        result["checks"].append(check(name, response["status"] == expected, response_status=response["status"]))
    # Keep bridge descriptor close-on-exec: Chromium only receives its own pipes.
    os.set_inheritable(bridge_fd, False)
    node_source = '''
import { startSession } from "/opt/eclipse/desktop/session-worker.mjs";
import { createHash } from "node:crypto";
const session = await startSession(JSON.parse(process.argv[1]));
try {
  const page = session.context.pages()[0] ?? await session.context.newPage();
  await page.goto("http://127.0.0.1:18081/", {timeout:10000});
  await page.locator("#go").click();
  const clicked = await page.locator("#go").textContent() === "clicked";
  const png = await page.screenshot();
  await page.goto("chrome://sandbox");
  const text = await page.locator("body").innerText();
  console.log(JSON.stringify({clicked, screenshotBytes:png.length,
    screenshotSha256:createHash("sha256").update(png).digest("hex"),
    sandboxNamespace:/Layer 1 Sandbox\\s+Namespace|Namespace sandbox\\s+Yes/i.test(text),
    sandboxPid:/PID namespaces\\s+Yes/i.test(text),
    sandboxNetwork:/Network namespaces\\s+Yes/i.test(text),
    sandboxSeccomp:/Seccomp-BPF sandbox\\s+Yes/i.test(text)}));
} finally { await session.close(); }
'''
    node = subprocess.run(["node", "--input-type=module", "-e", node_source, json.dumps(record)],
                          capture_output=True, timeout=45, check=False)
    try:
        browser = json.loads(node.stdout)
        ok = node.returncode == 0 and browser["clicked"] and browser["screenshotBytes"] > 100 and all(browser[key] for key in ("sandboxNamespace", "sandboxPid", "sandboxNetwork", "sandboxSeccomp"))
        result["checks"].append(check("chromium", ok, **browser))
    except (ValueError, KeyError):
        # No raw browser diagnostics (can contain private content in general).
        result["checks"].append(check("chromium", False, exit_code=node.returncode))
    print(json.dumps(result), flush=True)
    sys.stdin.readline()  # Parent controls this synthetic session's lifetime.
    marker.shutdown()
    proxy.shutdown()
    stream.close()
    bridge.close()


def main():
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location("desktop_bootstrap", BASE + "/bootstrap.py")
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    initial = identity()
    assert initial["uid"] == 0 and all(int(initial[key], 16) == bootstrap.INITIAL for key in ("CapEff", "CapPrm", "CapBnd"))
    assert initial["NoNewPrivs"] == "1"
    assert hashlib.sha256(pathlib.Path(BASE + "/seccomp_profile.json").read_bytes().replace(b"\r\n", b"\n")).hexdigest() == bootstrap.PROFILE_HASH
    bootstrap.setup()
    bootstrap.reduce_privileges()
    reduced = identity()
    report = {"initial": initial, "supervisor": reduced, "checks": [], "agents": []}
    report["checks"].append(check("supervisor_privilege_reduction", all(int(reduced[key], 16) == bootstrap.ADMIN for key in ("CapEff", "CapPrm", "CapBnd")) and int(reduced["Seccomp_filters"]) >= 2))
    fixture = server(Fixture, 18080)
    listeners = []
    for address in ("/tmp/task071-shared.sock", "\0task071-shared", "/run/eclipse/task071-private.sock"):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(address)
        if not address.startswith("\0"):
            os.chmod(address, 0o777)
        listener.listen(16)
        listeners.append(listener)
    workers = []
    try:
        records = [json.loads(call(["node", BASE + "/agent-admin.mjs", "create", OWNER, agent])) for agent in AGENTS]
        records = [{key: value for key, value in record.items() if key not in ("home", "downloads")} for record in records]
        for record in [records[0], records[1], records[0]]:
            parent, endpoint = socket.socketpair()
            threading.Thread(target=serve_bridge, args=(parent, record["agentId"]), daemon=True).start()
            args = ["setpriv", "--reuid", str(record["uid"]), "--regid", str(record["gid"]), "--clear-groups",
                    "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
                    "python3", SELF, "--child", json.dumps(record), str(endpoint.fileno())]
            worker = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      pass_fds=(endpoint.fileno(),), env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"})
            workers.append(worker)
            endpoint.close()
            line = worker.stdout.readline(65537)
            result = json.loads(line)
            result["round"] = len(report["agents"]) + 1
            report["agents"].append(result)
            if len(workers) == 2:
                workers[0].communicate(input=b"stop\n", timeout=8)
            if worker.poll() is not None:
                continue
        for worker in workers:
            if worker.poll() is None:
                worker.communicate(input=b"stop\n", timeout=8)
        nets = [agent.get("inner", {}).get("net") for agent in report["agents"]]
        report["checks"].append(check("distinct_and_recreated_namespaces", None not in nets and len(set(nets)) == 3, namespaces=nets))
        report["checks"].append(check("sessions_reaped", all(worker.returncode == 0 for worker in workers)))
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=3)
        fixture.shutdown()
        for listener in listeners:
            listener.close()
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    signal.alarm(210)
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--child":
            child(json.loads(sys.argv[2]), int(sys.argv[3]))
        elif len(sys.argv) == 1:
            main()
        else:
            raise RuntimeError("invalid_arguments")
    except Exception as failure:
        print(json.dumps({"error": "probe_failed", "type": type(failure).__name__,
                          "errno": errno.errorcode.get(getattr(failure, "errno", None), "unspecified")}), flush=True)
        sys.exit(1)
