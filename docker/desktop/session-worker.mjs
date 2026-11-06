import { TeachCapture } from "./teach-capture.mjs";
import { TeachSchema } from "./controller-schema.mjs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, unlink, readdir, realpath, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateIds, validateRegistry } from "./agent-store.mjs";
import { OperationSchema, WorkerOperationSchema, resultFor, screenInputRefusal, validatePng, windowClassOf, windowKindOf } from "./controller-schema.mjs";
import { fingerprint, readSnapshot, sessionCookies, writeSnapshot } from "./cookie-snapshot.mjs";
import { seedDesktop } from "./desktop-config.mjs";
import { AgentAudio } from "./agent-audio.mjs";
import { BROWSER_EXECUTABLE, BROWSER_PROFILE } from "./browser-build.mjs";
import { checkOpenable } from "./outbox-reader.mjs";
import { collectFrames, measureOrigin, takeSnapshot, verifySnapshot } from "./page-snapshot.mjs";
import { startSocketToTcpForwarder, startTcpToSocketForwarder } from "./egress-relay.mjs";

const COOKIE_SAVE_INTERVAL_MS = 30_000;
const fail = (code) => { throw Error(code); };
export const SESSION_FAILURES = new Set(["invalid_session_record", "agent_not_ready", "worker_identity_invalid", "worker_capabilities_invalid", "worker_security_invalid", "unsafe_session_path", "profile_busy_or_unsafe", "display_conflict", "xauthority_failed", "display_start_failed", "display_authentication_failed", "window_manager_start_failed", "browser_start_failed", "session_component_failed", "session_start_failed", "private_ipc_required", "egress_not_configured", "namespace_required"]);
export function runtimePrefix(uid) {
  if (!Number.isInteger(uid) || uid < 20000 || uid > 59999) fail("worker_identity_invalid");
  // Chromium adds its own directory and SingletonSocket; leave room below AF_UNIX's 108-byte limit.
  return `/tmp/ec-${uid}-`;
}
export function sessionRecord(value) {
  if (!value || Object.keys(value).sort().join() !== "agentId,gid,name,ownerId,state,uid") fail("invalid_session_record");
  validateIds(value.ownerId, value.agentId); validateRegistry({ version: 1, agents: [value] });
  if (value.state !== "ready") fail("agent_not_ready");
  return { ...value, home: `/workspace/homes/${value.agentId}`, downloads: `/downloads/${value.agentId}`, display: value.uid - 20000 + 100 };
}
async function privateDirectory(name, uid) {
  const s = await lstat(name);
  if (!s.isDirectory() || s.uid !== uid || s.gid !== uid || (s.mode & 0o7777) !== 0o700) fail("unsafe_session_path");
}
// Parse kernel identity, never caller-selected command text. Birth time prevents PID-reuse signals.
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const s = await readFile(`/proc/${pid}/stat`, "utf8"); const fields = s.slice(s.lastIndexOf(")") + 2).split(" ");
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return { pid, birth: fields[19], parent: +fields[1], uid: +/^Uid:\s+(\d+)/m.exec(status)?.[1], zombie: fields[0] === "Z" };
  } catch { return null; }
}
async function recoverProfile(profile, uid) {
  const lock = `${profile}/SingletonLock`;
  let value; try { value = await lstat(lock); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  if (!value.isSymbolicLink() || value.uid !== uid) fail("profile_busy_or_unsafe");
  const target = await readlink(lock); const split = target.lastIndexOf("-"); const pid = +target.slice(split + 1);
  if (split < 1 || !Number.isInteger(pid) || pid < 1) fail("profile_busy_or_unsafe");
  const holder = target.slice(0, split) === hostname() ? await processIdentity(pid) : null;
  if (holder && !holder.zombie) fail("profile_busy_or_unsafe");
  for (const item of await readdir("/proc")) {
    const identity = await processIdentity(+item);
    if (identity?.uid !== uid || identity.zombie) continue;
    let command; try { command = await readFile(`/proc/${item}/cmdline`, "utf8"); } catch { fail("profile_busy_or_unsafe"); }
    if (command.split("\0").includes(`--user-data-dir=${profile}`)) fail("profile_busy_or_unsafe");
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      const file = `${profile}/${name}`; const st = await lstat(file);
      if (!st.isSymbolicLink() || st.uid !== uid) fail("profile_busy_or_unsafe");
      await unlink(file); // Unlink the verified link itself, never its target.
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}
async function cleanDisplay(record, tracked) {
  const lock = `/tmp/.X${record.display}-lock`; const socket = `/tmp/.X11-unix/X${record.display}`;
  let file; try { file = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  let pid;
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== record.uid || st.size > 32) fail("unsafe_display_cleanup");
    const text = (await file.readFile("utf8")).trim(); if (!/^\d+$/.test(text)) fail("unsafe_display_cleanup"); pid = +text;
  } finally { await file.close(); }
  const current = await processIdentity(pid);
  if (!tracked.some((item) => item.pid === pid)) return; // A conflicting display is never ours to remove.
  if (current && !current.zombie) fail("unsafe_display_cleanup");
  try { const st = await lstat(socket); if (!st.isSocket() || st.uid !== record.uid) fail("unsafe_display_cleanup"); await unlink(socket); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  await unlink(lock);
}
async function sweepSessionProcesses(uid) {
  // Dock-launched xterm children are not in the worker's tracked list. Only verified
  // agent-owned native desktop programs are reaped here; nothing else.
  const native = new Set(["xterm", "pcmanfm", "tint2", "dbus-daemon", "pulseaudio"]);
  const isNative = (argv) => native.has((argv[0] ?? "").split("/").pop());
  for (const item of await readdir("/proc")) {
    const pid = +item;
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) continue;
    const identity = await processIdentity(pid);
    if (identity?.uid !== uid || identity.zombie) continue;
    let argv; try { argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean); } catch { continue; }
    if (!isNative(argv)) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
  for (let i = 0; i < 20; i++) {
    let alive = false;
    for (const item of await readdir("/proc")) {
      const pid = +item; if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) continue;
      const identity = await processIdentity(pid);
      if (identity?.uid !== uid || identity.zombie) continue;
      let argv; try { argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean); } catch { continue; }
      if (isNative(argv)) { alive = true; break; }
    }
    if (!alive) return;
    await delay(50);
  }
}
async function findBrowserPid(profile, uid) {
  // 15 s covers a cold first start on a freshly built image; the caller is still bounded by the lifecycle timeout.
  for (let i = 0; i < 150; i++) {
    for (const item of await readdir("/proc")) {
      const pid = +item; if (!Number.isInteger(pid) || pid < 1) continue;
      const identity = await processIdentity(pid);
      if (identity?.uid !== uid || identity.zombie) continue;
      let argv; try { argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean); } catch { continue; }
      // Chromium re-execs with its whole command line packed into argv[0], so inspect the joined text.
      const command = argv.join(" ");
      if (command.includes("--type=")) continue;
      if (!command.includes(BROWSER_EXECUTABLE)) continue;
      const at = argv.findIndex((arg) => arg === "--user-data-dir");
      if (command.includes(`--user-data-dir=${profile}`) || at >= 0 && argv[at + 1] === profile) return pid;
    }
    await delay(100);
  }
  return null;
}
function dbusSessionConfig(socketPath) {
  // Private session bus with no servicedir, so nothing can activate a service.
  return `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${socketPath}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow user="*"/>
    <allow own="*"/>
    <allow send_type="method_call"/>
    <allow send_type="signal"/>
    <allow send_type="method_return"/>
    <allow send_type="error"/>
    <allow receive_type="method_call"/>
    <allow receive_type="method_return"/>
    <allow receive_type="error"/>
    <allow receive_type="signal"/>
  </policy>
  <limit name="max_connections_per_user">64</limit>
  <limit name="max_message_size">16777216</limit>
</busconfig>
`;
}
// Sandbox, graphics and browser are independent. The worker process is the sandbox: shell and file work need it,
// while Xvfb/Chromium/VNC can be started, stopped or lost without ending it.
export async function startSession(input, { onRuntime = () => {}, onEvent = () => {}, autoStart = true } = {}) {
  const record = sessionRecord(input); const uid = process.getuid();
  if (uid !== record.uid || process.getgid() !== record.gid || process.getgroups().some((group) => group !== record.gid)) fail("worker_identity_invalid");
  const status = await readFile("/proc/self/status", "utf8");
  for (const field of ["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"]) if (!new RegExp(`^${field}:\\s+0+$`, "m").test(status)) fail("worker_capabilities_invalid");
  if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status) || +/^Seccomp_filters:\s+(\d+)/m.exec(status)?.[1] < 2) fail("worker_security_invalid");
  // TASK-071. Fail closed unless the worker is in its own network namespace with only loopback.
  const interfaces = Object.keys(networkInterfaces());
  if (interfaces.length !== 1 || interfaces[0] !== "lo") fail("namespace_required");
  const nsDirectory = `/run/eclipse-ns/${record.agentId}`;
  await privateDirectory(record.home, uid); await privateDirectory(`${record.home}/.config`, uid);
  const profile = `${record.home}/${BROWSER_PROFILE}`; await privateDirectory(profile, uid); await privateDirectory(record.downloads, uid);
  const directory = await mkdtemp(runtimePrefix(record.uid)); const original = await lstat(directory);
  onRuntime(directory);
  const authority = `${directory}/Xauthority`;
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: record.home, USER: record.name, LOGNAME: record.name, LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: `${directory}/runtime`, XDG_CONFIG_HOME: `${record.home}/.config`, XDG_DATA_HOME: `${record.home}/.local/share`,
    XDG_CACHE_HOME: `${record.home}/.cache`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/runtime/bus`,
    DBUS_SYSTEM_BUS_ADDRESS: "disabled:", TERM: "xterm-256color", TMPDIR: directory };
  // SIGKILL on timeout: pcmanfm traps SIGTERM, so a `pcmanfm --set-wallpaper` that found no desktop instance
  // (it then becomes the primary and stays up) blocked this synchronous call, and the whole worker, forever.
  const command = (executable, args, extra = {}) => spawnSync(executable, args, { env, stdio: "ignore", timeout: 1000, killSignal: "SIGKILL", ...extra });
  const audio = new AgentAudio({ directory, home: record.home, uid, env });
  let children = []; let context = null; let teach = null; let vnc = null; let vncForwarder = null; let vncAbort = new AbortController();
  let graphics = "stopped", browser = "stopped"; let sandboxReady = false; let closing = false;
  let graphicsClosing = false, browserClosing = false, browserPid = null;
  let graphicsStart = null, browserStart = null, lifecycle = Promise.resolve();
  let egressForwarder; let gatewayForwarder;
  // Session cookies (no expiry) are not kept by Chromium's profile; see cookie-snapshot.mjs.
  let cookieTimer; let savedCookies = ""; let savingCookies = false;
  const emit = (value) => { try { onEvent(value); } catch { /* events are informational */ } };
  const serialize = (work) => { const next = lifecycle.catch(() => {}).then(work); lifecycle = next.catch(() => {}); return next; };
  const state = () => ({ agentId: record.agentId, state: sandboxReady ? "running" : "starting",
    sandbox: sandboxReady ? "running" : "starting", graphics, browser, display: record.display,
    ...(vnc && graphics === "running" ? { vncPort: vnc.vncPort, vncReady: true } : {}) });
  const saveCookies = async () => {
    if (!context || savingCookies) return; savingCookies = true;
    try {
      const cookies = sessionCookies(await context.cookies()); const text = fingerprint(cookies);
      if (text !== savedCookies) { await writeSnapshot(profile, cookies); savedCookies = text; }
    } catch { /* A failed save never affects the session; the next save retries. */ } finally { savingCookies = false; }
  };
  const startChild = (role, executable, args) => {
    const child = spawn(executable, args, { env, stdio: "ignore", shell: false });
    const item = { child, role, pid: child.pid }; children.push(item);
    const lost = () => {
      if (closing) return;
      if (role === "graphics" && !graphicsClosing && (graphics === "running" || graphics === "starting")) {
        graphics = "failed"; emit({ state: "desktop_failed", reason: "session_component_failed" });
      }
    };
    child.once("error", lost); child.once("exit", lost); return child;
  };
  const roleAlive = (role) => children.some((item) => item.role === role && item.child.exitCode === null && item.child.signalCode === null);
  const untilRole = async (role, probe, code) => {
    for (let i = 0; i < 60; i++) { if (!roleAlive(role)) fail(code); if (probe()) return; await delay(100); }
    fail(code);
  };
  const windowSearch = (pattern) => {
    const result = command("xdotool", ["search", "--classname", pattern], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 && result.stdout.trim().length > 0;
  };
  const stopGraphicsChildren = async () => {
    graphicsClosing = true;
    vncAbort.abort();
    await vnc?.close().catch(() => {}); vnc = null;
    await vncForwarder?.close().catch(() => {}); vncForwarder = null;
    for (const item of [...children].reverse()) if (item.role === "graphics") { try { item.child.kill("SIGTERM"); } catch { /* already stopped */ } }
    for (let i = 0; i < 20 && children.some((item) => item.role === "graphics" && item.child.exitCode === null && item.child.signalCode === null); i++) await delay(50);
    for (const item of children) if (item.role === "graphics" && item.child.exitCode === null && item.child.signalCode === null) { try { item.child.kill("SIGKILL"); } catch { /* already stopped */ } }
    for (let i = 0; i < 20 && children.some((item) => item.role === "graphics" && item.child.exitCode === null && item.child.signalCode === null); i++) await delay(50);
    await sweepSessionProcesses(uid);
    await audio.stop().catch(() => {});
    await cleanDisplay(record, children.map((item) => ({ pid: item.pid }))).catch(() => {});
    await unlink(authority).catch((error) => { if (error.code !== "ENOENT") throw error; });
    children = children.filter((item) => item.role !== "graphics");
  };
  const stopBrowser = async () => {
    if (browser === "stopped" && !context && !browserPid) return;
    browserClosing = true;
    clearInterval(cookieTimer); cookieTimer = undefined;
    if (context && browser === "running") { savingCookies = false; await Promise.race([saveCookies(), delay(1500)]); }
    const current = context; context = null; teach = null;
    if (current) await Promise.race([current.close().catch(() => {}), delay(3000)]);
    // A close can hang behind a renderer; only the verified browser process is ever signalled.
    const pid = browserPid ?? await findBrowserPid(profile, uid).catch(() => null);
    if (pid) {
      const identity = await processIdentity(pid);
      if (identity && identity.uid === uid && !identity.zombie) {
        try { process.kill(pid, "SIGTERM"); } catch { /* exited */ }
        for (let i = 0; i < 20; i++) { const now = await processIdentity(pid); if (!now || now.zombie) break; await delay(50); }
        const now = await processIdentity(pid);
        if (now && !now.zombie) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
      }
    }
    browserPid = null;
    await unlink(`${env.XDG_RUNTIME_DIR}/browser.pid`).catch((error) => { if (error.code !== "ENOENT") throw error; });
    browser = "stopped"; browserClosing = false;
    if (!closing) emit({ state: "browser_stopped" });
  };
  const ensureGraphics = async () => {
    if (graphics === "running") return;
    if (graphicsStart) return graphicsStart;
    graphicsStart = (async () => {
      if (graphics === "failed" || children.some((item) => item.role === "graphics")) await stopGraphicsChildren();
      graphics = "starting"; graphicsClosing = false; emit({ state: "desktop_starting" });
      // A conflicting X server is never removed or adopted.
      for (const name of [`/tmp/.X${record.display}-lock`, `/tmp/.X11-unix/X${record.display}`]) {
        try { await lstat(name); fail("display_conflict"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      }
      await mkdir(`${directory}/runtime`, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      if (!authority) fail("unsafe_session_path");
      await writeFile(authority, "", { flag: "wx", mode: 0o600 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      const result = command("xauth", ["-f", authority], { input: `add :${record.display} MIT-MAGIC-COOKIE-1 ${randomBytes(16).toString("hex")}\n`, stdio: ["pipe", "ignore", "ignore"] });
      if (result.status !== 0) fail("xauthority_failed");
      env.DISPLAY = `:${record.display}`; env.XAUTHORITY = authority;
      startChild("graphics", "Xvfb", [`:${record.display}`, "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-auth", authority, "-noreset"]);
      await untilRole("graphics", () => command("xdpyinfo", []).status === 0, "display_start_failed");
      if (command("xdpyinfo", [], { env: { ...env, XAUTHORITY: `${directory}/absent` } }).status === 0) fail("display_authentication_failed");
      startChild("graphics", "openbox", ["--sm-disable"]);
      await untilRole("graphics", () => /window id # 0x[1-9a-f]/i.test(command("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? ""), "window_manager_start_failed");
      // TASK-077. Seed only missing agent-local desktop config, then start the private bus
      // before the native desktop children so nothing can reach a host or system bus.
      await seedDesktop({ home: record.home, downloads: record.downloads, uid });
      const busPath = `${directory}/runtime/bus`;
      await writeFile(`${directory}/dbus.conf`, dbusSessionConfig(busPath), { flag: "wx", mode: 0o600 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      startChild("graphics", "dbus-daemon", ["--config-file", `${directory}/dbus.conf`, "--nofork", "--nopidfile"]);
      await untilRole("graphics", () => command("test", ["-S", busPath]).status === 0, "session_component_failed");
      const busStat = await lstat(busPath);
      if (!busStat.isSocket() || busStat.uid !== uid) fail("session_component_failed");
      if (vncAbort.signal.aborted) vncAbort = new AbortController();
      const { startVnc } = await import("./vnc-session.mjs");
      vnc = await startVnc({ directory, display: record.display, signal: vncAbort.signal, onFailure: () => {
        if (!closing && !graphicsClosing && graphics === "running") { graphics = "failed"; emit({ state: "desktop_failed", reason: "session_component_failed" }); }
      } });
      // TASK-071: the controller reaches this pathname socket; x11vnc stays on the namespace loopback.
      vncForwarder = await startSocketToTcpForwarder({ socketPath: `${nsDirectory}/vnc.sock`, port: vnc.vncPort });
      emit({ state: "vnc_ready", vncPort: vnc.vncPort, password: vnc.password });
      startChild("graphics", "pcmanfm", ["--desktop", "--profile=default"]);
      await untilRole("graphics", () => windowSearch("[Pp]cmanfm"), "session_component_failed");
      // Owner-supplied wallpaper (cosmetic only): a failure here never fails graphics.
      try {
        command("pcmanfm", ["--set-wallpaper", "/opt/eclipse/desktop/desktop-config/wallpaper.png", "--wallpaper-mode=fit"]);
      } catch { /* solid desktop background remains */ }
      startChild("graphics", "tint2", ["-c", `${record.home}/.config/tint2/tint2rc`]);
      await untilRole("graphics", () => windowSearch("[Tt]int2"), "session_component_failed");
      graphics = "running"; emit({ state: "desktop_running", display: record.display });
    })().catch(async (error) => {
      await stopGraphicsChildren().catch(() => {});
      graphics = "failed";
      if (!closing) emit({ state: "desktop_failed", reason: SESSION_FAILURES.has(error.message) ? error.message : "session_component_failed" });
      throw error;
    }).finally(() => { graphicsStart = null; });
    return graphicsStart;
  };
  const ensureBrowser = async () => {
    if (browser === "running" && context) return;
    if (browserStart) return browserStart;
    browserStart = (async () => {
      await ensureGraphics();
      browser = "starting"; browserClosing = false; emit({ state: "browser_starting" });
      // TASK-079. The private speaker starts before Chromium; a failed speaker never blocks the browser.
      try { await audio.start(); } catch { /* hearing unavailable */ }
      await recoverProfile(profile, uid);
      const { chromium } = await import("playwright-core");
      try {
        context = await chromium.launchPersistentContext(profile, { executablePath: BROWSER_EXECUTABLE, chromiumSandbox: true,
          headless: false, viewport: null, env, downloadsPath: record.downloads, timeout: 15000,
          // TASK-045: the token is Playwright's proxy password (Chromium answers the 407 in memory, never argv/env).
          // Loopback bypass keeps the mock vendor fixture reachable; shared loopback is a TASK-071 limit.
          // TASK-071: plain loopback proxy; the supervisor relay adds the token outside this namespace.
          proxy: { server: "http://127.0.0.1:3128", bypass: "127.0.0.1,localhost" },
          // The dock is 28 px at the bottom of the 1024x768 screen. A full-height window covered it, so neither an agent nor the
          // owner could reach it.
          args: ["--window-position=0,0", "--window-size=1024,738", "--disable-dev-shm-usage", "--disable-background-networking", "--no-first-run"] });
      } catch (cause) {
        browser = "failed"; emit({ state: "browser_failed", reason: "browser_start_failed" });
        throw Error("browser_start_failed", { cause });
      }
      try {
        const restored = await readSnapshot(profile, uid);
        if (restored.length) await context.addCookies(restored);
      } catch { /* Start without restored cookies rather than failing the browser. */ }
      try { savedCookies = fingerprint(sessionCookies(await context.cookies())); } catch { savedCookies = ""; }
      cookieTimer = setInterval(() => { void saveCookies(); }, COOKIE_SAVE_INTERVAL_MS); cookieTimer.unref();
      context.once("close", () => {
        if (closing || browserClosing) return;
        clearInterval(cookieTimer); cookieTimer = undefined; context = null; teach = null; browser = "stopped";
        emit({ state: "browser_stopped" });
      });
      // TASK-077. The dock focuses the browser by the real process, never by window title.
      browserPid = await findBrowserPid(profile, uid);
      if (!browserPid) {
        await Promise.race([context.close().catch(() => {}), delay(3000)]);
        context = null; browser = "failed"; emit({ state: "browser_failed", reason: "browser_start_failed" });
        fail("browser_start_failed");
      }
      await writeFile(`${env.XDG_RUNTIME_DIR}/browser.pid`, `${browserPid}\n`, { mode: 0o600 });
      teach = new TeachCapture(context, { env });
      browser = "running"; emit({ state: "browser_running" });
    })().catch((error) => { if (browser !== "failed") { browser = "failed"; if (!closing) emit({ state: "browser_failed", reason: "browser_start_failed" }); } throw error; })
      .finally(() => { browserStart = null; });
    return browserStart;
  };
  const session = {
    get context() { return context; },
    get teach() { return teach; },
    audio,
    env, display: record.display, directory, home: record.home, nsDirectory,
    state,
    startDesktop: () => serialize(async () => { await ensureGraphics(); await ensureBrowser(); return state(); }),
    stopDesktop: () => serialize(async () => { await stopBrowser(); if (graphics !== "stopped") { await stopGraphicsChildren(); graphics = "stopped"; if (!closing) emit({ state: "desktop_stopped" }); } return state(); }),
    startBrowser: () => serialize(async () => { await ensureBrowser(); return state(); }),
    stopBrowser: () => serialize(async () => { await stopBrowser(); return state(); }),
    async close() {
      if (closing) return; closing = true;
      await audio.stop().catch(() => {});
      await stopBrowser().catch(() => {});
      if (graphics !== "stopped" || vnc || vncForwarder) { await stopGraphicsChildren().catch(() => {}); graphics = "stopped"; }
      await egressForwarder?.close().catch(() => {});
      await gatewayForwarder?.close().catch(() => {});
      const st = await lstat(directory).catch(() => null);
      if (st?.isDirectory() && st.uid === uid && st.ino === original.ino && await realpath(directory) === directory) await rm(directory, { recursive: true });
    },
  };
  try {
    // The sandbox only needs its private runtime, the egress relays and the agent's config; no display or browser.
    await mkdir(`${directory}/runtime`, { mode: 0o700 }); await writeFile(authority, "", { flag: "wx", mode: 0o600 });
    egressForwarder = await startTcpToSocketForwarder({ socketPath: `${nsDirectory}/egress.sock` }).catch(() => fail("egress_not_configured"));
    // TASK-073b: git's plain-HTTP gateway stays optional so a session without the supervisor relay still starts.
    gatewayForwarder = await startTcpToSocketForwarder({ port: 3129, socketPath: `${nsDirectory}/gateway.sock` }).catch(() => null);
    await seedDesktop({ home: record.home, downloads: record.downloads, uid });
    sandboxReady = true;
    // Direct callers (tests and the standalone smoke scripts) keep the original one-call graphical session.
    // The supervisor passes autoStart:false and drives the three lifecycles over the framed pipe.
    if (autoStart) await session.startDesktop();
    return session;
  } catch (e) { await session.close().catch(() => {}); throw e; }
}

// Safe URL: strip credentials, search, hash — return only origin + pathname
function safeHref(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

const OPERATION_TIMEOUT_MS = 4000;
// Reads change nothing, so a slow page is reported as busy and the session keeps running. Only input whose outcome is unknown
// quarantines a session (SECURITY: uncertain execution). Checking focus is also a read: when it runs out of time, nothing was
// typed, so that is a plain refusal. Worker bound < controller channel < app fetch, as for navigation.
export const PAGE_READ_TIMEOUT_MS = 12_000;
export const FOCUS_INPUT_TIMEOUT_MS = 9_000;
const SAFETY_CHECK_MS = 7_000;
const READ_OPERATIONS = new Set(["capture.screenshot", "window.active", "browser.pages", "page.snapshot", "page.verify", "page.find_text"]);
const PAGE_READS = new Set(["page.snapshot", "page.verify", "page.find_text"]);
const CHECKED_INPUT = new Set(["input.type", "input.key", "input.screen_type", "input.screen_key", "input.screen_click", "input.screen_drag"]);
// Real sites behind the egress proxy can take many seconds to respond, so navigation has its own, longer bound.
// Commit budget < load budget < worker bound (NAVIGATION_TIMEOUT_MS + 2 s) < controller channel < app fetch.
export const NAVIGATION_COMMIT_MS = 15_000;
export const NAVIGATION_TIMEOUT_MS = 20_000;
const pageIds = new WeakMap();
const operationError = (code) => Object.assign(Error(code), { code });
function pageId(page) {
  if (!pageIds.has(page)) pageIds.set(page, randomUUID());
  return pageIds.get(page);
}
function boundedOperation(run, timeoutMs = OPERATION_TIMEOUT_MS, timeoutCode = "uncertain_outcome") {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(operationError(timeoutCode)); }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]).finally(() => clearTimeout(timer));
}
function desktopProcess(session, executable, args, { input, maxOutput = 4096, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(operationError("uncertain_outcome"));
    const child = spawn(executable, args, { env: session.env, shell: false, stdio: ["pipe", "pipe", "ignore"] });
    let done = false, total = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (done) return; done = true; signal?.removeEventListener("abort", abort);
      if (error) { try { child.kill("SIGKILL"); } catch { /* exited */ } reject(error); }
      else resolve(result);
    };
    const abort = () => finish(operationError("uncertain_outcome"));
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(operationError("desktop_command_failed")));
    child.stdin.on("error", () => finish(operationError("desktop_command_failed")));
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxOutput) return finish(operationError("desktop_result_too_large"));
      chunks.push(chunk);
    });
    child.on("close", (code) => finish(code === 0 ? null : operationError("desktop_command_failed"), Buffer.concat(chunks)));
    child.stdin.end(input ?? undefined);
  });
}
// Evaluated only against actual DOM elements, never against selector text.
function targetMetadata(element) {
  const focusCheck = element === undefined;
  if (focusCheck && !document.hasFocus()) return { focused: false, sensitive: false, editable: false };
  let target = focusCheck ? document.activeElement : element;
  while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  if (!target || focusCheck && ["IFRAME", "FRAME"].includes(target.tagName)) return { focused: false, sensitive: false, editable: false };
  const get = (name) => (target.getAttribute?.(name) ?? "").toLowerCase();
  const type = String(target.type ?? "").toLowerCase();
  const editable = target.isContentEditable === true || target.tagName === "TEXTAREA" || target.ownerDocument?.designMode === "on" ||
    target.tagName === "INPUT" && !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file", "color", "hidden"].includes(type) ||
    ["textbox", "searchbox", "combobox", "spinbutton"].includes(get("role"));
  const autocomplete = get("autocomplete").split(/\s+/);
  const semantics = [get("name"), get("id"), get("aria-label")].join(" ");
  const numericCode = get("inputmode") === "numeric" && target.maxLength >= 4 && target.maxLength <= 8;
  return { focused: focusCheck, editable, sensitive: type === "password" || autocomplete.some((value) => ["one-time-code", "current-password", "new-password"].includes(value)) ||
    /password|passwd|passcode|(?:^|[\s_-])(?:otp|totp)(?:$|[\s_-])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/.test(semantics) || numericCode };
}
function shadowTargetMetadata() {
  if (!document.hasFocus()) return { focused: false, sensitive: false, editable: false };
  let focused = false, editable = false;
  for (const root of this) {
    let target = root.activeElement;
    while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
    if (!target) continue;
    focused = true;
    const get = (name) => (target.getAttribute?.(name) ?? "").toLowerCase();
    const type = String(target.type ?? "").toLowerCase();
    editable ||= target.isContentEditable === true || target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT" && !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file", "color", "hidden"].includes(type) ||
      ["textbox", "searchbox", "combobox", "spinbutton"].includes(get("role"));
    const autocomplete = get("autocomplete").split(/\s+/);
    const semantics = [get("name"), get("id"), get("aria-label")].join(" ");
    const numericCode = get("inputmode") === "numeric" && target.maxLength >= 4 && target.maxLength <= 8;
    const sensitive = type === "password" || autocomplete.some((value) => ["one-time-code", "current-password", "new-password"].includes(value)) ||
      /password|passwd|passcode|(?:^|[\s_-])(?:otp|totp)(?:$|[\s_-])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/.test(semantics) || numericCode;
    if (sensitive) return { focused: true, sensitive: true, editable: true };
  }
  return { focused, sensitive: false, editable };
}
async function focusedTargetMetadata(page) {
  const session = await page.context().newCDPSession(page);
  const contexts = new Map();
  const onContext = ({ context }) => { if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id); };
  session.on("Runtime.executionContextCreated", onContext);
  try {
    await session.send("Runtime.enable");
    const tree = await session.send("Page.getFrameTree");
    const frames = [], queue = [tree.frameTree];
    while (queue.length) {
      const item = queue.shift();
      frames.push(item.frame);
      if (frames.length > 64) throw operationError("too_many_frames");
      queue.push(...(item.childFrames ?? []));
    }
    let focused = false, editable = false;
    for (const frame of frames) {
      const contextId = contexts.get(frame.id);
      if (!contextId) return { focused: false, sensitive: false };
      const readMetadata = async (objectId, functionDeclaration) => {
        try {
          const response = await session.send("Runtime.callFunctionOn", { objectId, functionDeclaration, returnByValue: true });
          if (response.exceptionDetails) return { focused: false, sensitive: false };
          return response.result.value ?? { focused: false, sensitive: false };
        } finally { await session.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
      };
      const documentObject = await session.send("Runtime.evaluate", { expression: "document", contextId });
      if (!documentObject.result.objectId) return { focused: false, sensitive: false };
      let state = await readMetadata(documentObject.result.objectId, targetMetadata.toString());
      if (state.sensitive) return state;
      focused ||= state.focused;
      editable ||= state.editable === true;
      const prototype = await session.send("Runtime.evaluate", { expression: "ShadowRoot.prototype", contextId });
      if (!prototype.result.objectId) return { focused: false, sensitive: false };
      try {
        const roots = await session.send("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId });
        if (!roots.objects.objectId) return { focused: false, sensitive: false };
        state = await readMetadata(roots.objects.objectId, shadowTargetMetadata.toString());
        if (state.sensitive) return state;
        focused ||= state.focused;
        editable ||= state.editable === true;
      } finally { await session.send("Runtime.releaseObject", { objectId: prototype.result.objectId }).catch(() => {}); }
    }
    return { focused, sensitive: false, editable };
  } finally {
    session.off("Runtime.executionContextCreated", onContext);
    await session.detach().catch(() => {});
  }
}
// A safety check that runs out of time or breaks refuses the input. Nothing has been sent at that point.
async function withinSafetyCheck(work) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(operationError("focused_target_unknown")), SAFETY_CHECK_MS); });
  try { return await Promise.race([work(), expired]); }
  catch (error) {
    if (["sensitive_target", "focused_target_unknown", "too_many_pages", "too_many_frames"].includes(error?.code)) throw error;
    throw operationError("focused_target_unknown");
  }
  finally { clearTimeout(timer); }
}
// `needsField`: typing into a page with no field selected goes nowhere, and the model cannot tell from a screenshot.
async function requireSafeFocus(context, signal, { needsField = false } = {}) {
  if (signal.aborted) throw operationError("uncertain_outcome");
  await withinSafetyCheck(async () => {
    let focused = false, editable = false;
    const pages = context.pages();
    if (pages.length > 32) throw operationError("too_many_pages");
    for (const page of pages) {
      // The keyboard only reaches the page that has focus. Walking every frame's objects in the others cost seconds on big
      // pages. A page too busy to answer is walked as before.
      const active = await Promise.race([page.evaluate(() => document.hasFocus()).catch(() => true), delay(1000).then(() => true)]);
      if (!active) continue;
      const state = await focusedTargetMetadata(page);
      if (state.sensitive) throw operationError("sensitive_target");
      focused ||= state.focused;
      editable ||= state.editable === true;
      if (signal.aborted) throw operationError("uncertain_outcome");
    }
    if (!focused || (needsField && !editable)) throw operationError("focused_target_unknown");
  });
}
const xKeys = { Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "super", Enter: "Return", Space: "space", Backspace: "BackSpace",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", PageUp: "Prior", PageDown: "Next" };

// TASK-084. Page helpers. None of them returns page text: find_text returns a count, select changes one control.
const normalizeSpace = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
function deepElementAt([x, y]) {
  let hit = document.elementFromPoint(x, y);
  const walked = new Set();
  while (hit && hit.shadowRoot && !walked.has(hit.shadowRoot)) {
    walked.add(hit.shadowRoot);
    const deeper = hit.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  return hit ?? null;
}
// A frame that holds password, one-time-code or card fields is sensitive: none of its text ever matches a find_text.
function frameHasSensitiveFields() {
  const seen = new Set();
  const check = (root) => {
    for (const input of root.querySelectorAll("input")) {
      const type = (input.type || "").toLowerCase();
      const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
      if (type === "password" || /(?:^|\s)cc-|(?:^|\s)(?:one-time-code|current-password|new-password)/.test(autocomplete)) return true;
    }
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        if (check(element.shadowRoot)) return true;
      }
    }
    return false;
  };
  return check(document);
}
async function findText(page, text) {
  const wanted = normalizeSpace(text);
  if (!wanted) return { found: false, count: 0, source_tag: "tool", untrusted: true };
  const infos = await collectFrames(page);
  let count = 0;
  try {
    for (const info of infos) {
      if (info.isPayment) continue;
      if (await info.frame.evaluate(frameHasSensitiveFields).catch(() => true)) continue;
      let matches;
      try { matches = await info.frame.getByText(text, { exact: false }).all(); } catch { continue; }
      for (const locator of matches.slice(0, 200)) {
        try {
          // getByText is case-insensitive; the value is only saved when the visible text contains it exactly.
          if (normalizeSpace(await locator.textContent({ timeout: 1000 })).includes(wanted)) count += 1;
        } catch { /* detached or hidden */ }
        if (count >= 1000) break;
      }
      if (count >= 1000) break;
    }
  } finally {
    for (const info of infos) await info.element?.dispose().catch(() => {});
  }
  return { found: count > 0, count, source_tag: "tool", untrusted: true };
}
async function choosePage(pages, wantedPageId) {
  if (wantedPageId) {
    const found = pages.find((candidate) => pageId(candidate) === wantedPageId);
    if (!found) throw operationError("page_not_found");
    return found;
  }
  if (pages.length === 1) return pages[0];
  // A page in the middle of a navigation may not answer, and with the address bar focused no page has focus.
  const ask = (page, question) => Promise.race([page.evaluate(question).catch(() => false), delay(800).then(() => false)]);
  // The visible tab first: a tab left in the background can still report hasFocus, which sent navigation to the wrong tab.
  for (const candidate of [...pages].reverse()) if (await ask(candidate, () => document.visibilityState === "visible")) return candidate;
  for (const candidate of pages) if (await ask(candidate, () => document.hasFocus())) return candidate;
  if (pages.length) return pages[pages.length - 1];
  throw operationError("page_not_found");
}
async function selectAt(session, page, command, signal) {
  const move = (x, y) => desktopProcess(session, "xdotool", ["mousemove", String(x), String(y)], { signal });
  const origin = await measureOrigin({ page, move, fail: operationError });
  const infos = await collectFrames(page);
  const local = { x: command.x - origin.x, y: command.y - origin.y };
  let chosen = null;
  for (const info of infos) {
    const area = info.visibleBox;
    if (area.width < 1 || area.height < 1) continue;
    if (local.x < area.x || local.x >= area.x + area.width || local.y < area.y || local.y >= area.y + area.height) continue;
    if (!chosen || info.depth >= chosen.depth) chosen = info;
  }
  let handle;
  try {
    if (!chosen) throw operationError("target_not_found");
    handle = await chosen.frame.evaluateHandle(deepElementAt, [Math.round(local.x - chosen.offset.x), Math.round(local.y - chosen.offset.y)]);
    const element = handle.asElement();
    if (!element) throw operationError("target_not_found");
    if (!(await element.evaluate((node) => node.tagName === "SELECT"))) throw operationError("target_not_found");
    if (signal.aborted) throw operationError("uncertain_outcome");
    try { await element.selectOption({ label: command.option }, { timeout: OPERATION_TIMEOUT_MS }); }
    catch {
      try { await element.selectOption({ value: command.option }, { timeout: OPERATION_TIMEOUT_MS }); }
      catch { throw operationError("option_not_found"); }
    }
    return { ok: true };
  } finally {
    await handle?.dispose().catch(() => {});
    for (const info of infos) await info.element?.dispose().catch(() => {});
  }
}
// ADR-041. Which kind of window has the keyboard. A failed read is "none", which takes no screen input.
// The pinned xdotool (3.20160805) has no getwindowclassname, so the class comes from xprop.
async function activeWindowKind(session, signal) {
  try {
    const id = (await desktopProcess(session, "xdotool", ["getactivewindow"], { signal })).toString("utf8").trim();
    if (!/^\d{1,12}$/.test(id)) return "none";
    return windowKindOf(windowClassOf((await desktopProcess(session, "xprop", ["-id", id, "WM_CLASS"], { signal })).toString("utf8")));
  } catch (error) { if (signal?.aborted) throw error; return "none"; }
}
// ADR-041. A model-chosen point inside a web page may not land on a password, one-time-code or card field, or in a payment
// frame. Points on the browser's own toolbar or tabs are outside every frame. A point that cannot be checked is refused.
async function requireSafePoint(session, command, signal) {
  await withinSafetyCheck(() => checkSafePoint(session, command, signal));
}
async function checkSafePoint(session, command, signal) {
  // Known windows outside the browser hold no page. "none" means the read failed, so the page is still checked.
  if (["terminal", "file_manager", "other"].includes(await activeWindowKind(session, signal))) return;
  const pages = session.context.pages();
  if (pages.length > 32) throw operationError("too_many_pages");
  const page = await choosePage(pages);
  const move = (x, y) => desktopProcess(session, "xdotool", ["mousemove", String(x), String(y)], { signal });
  let origin;
  try { origin = await measureOrigin({ page, move, fail: operationError }); } catch { throw operationError("focused_target_unknown"); }
  const infos = await collectFrames(page);
  const local = { x: command.x - origin.x, y: command.y - origin.y };
  let chosen = null;
  for (const info of infos) {
    const area = info.visibleBox;
    if (area.width < 1 || area.height < 1) continue;
    if (local.x < area.x || local.x >= area.x + area.width || local.y < area.y || local.y >= area.y + area.height) continue;
    if (!chosen || info.depth >= chosen.depth) chosen = info;
  }
  let handle;
  try {
    if (!chosen) return;
    if (chosen.isPayment) throw operationError("sensitive_target");
    handle = await chosen.frame.evaluateHandle(deepElementAt, [Math.round(local.x - chosen.offset.x), Math.round(local.y - chosen.offset.y)]);
    const element = handle.asElement();
    if (element && (await element.evaluate(targetMetadata)).sensitive) throw operationError("sensitive_target");
  } catch (error) {
    if (error?.code === "sensitive_target") throw error;
    throw operationError("focused_target_unknown");
  } finally {
    await handle?.dispose().catch(() => {});
    for (const info of infos) await info.element?.dispose().catch(() => {});
  }
}
async function performOperation(session, command, signal, trustedOwnerInput) {
  const { operation } = command;
  if (operation === "shell.run") {
    // TASK-073. The command runs as this worker user, inside this worker's network namespace.
    const { runShell } = await import("./shell-runner.mjs");
    return runShell({ command: command.command, cwd: command.cwd, timeout: command.timeout ?? 60, home: session.home, env: session.env });
  }
  if (operation === "audio.capture") {
    // TASK-079. Capture only this session's monitor; the app validates the WAV again before transcription.
    if (!session.audio) throw operationError("audio_unavailable");
    const captured = await session.audio.capture(command.seconds, signal);
    return { base64: captured.wav.toString("base64"), mime: "audio/wav", durationMs: captured.durationMs, source_tag: "tool", untrusted: true };
  }
  if (operation === "capture.screenshot") {
    const crop = command.crop;
    // The pointer is in the picture so an agent can see where its last click landed and correct it.
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-video_size", "1024x768", "-i", session.env.DISPLAY,
      "-frames:v", "1", "-threads", "1", "-filter_threads", "1"];
    if (crop) args.push("-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
    args.push("-f", "image2pipe", "-vcodec", "png", "pipe:1");
    const png = await desktopProcess(session, "ffmpeg", args, { maxOutput: 4 * 1024 * 1024, signal });
    const dimensions = validatePng(png, crop ?? { width: 1024, height: 768 });
    return { ...dimensions, base64: png.toString("base64"), source_tag: "tool", untrusted: true };
  }
  if (operation === "window.active") return { kind: await activeWindowKind(session, signal), source_tag: "tool", untrusted: true };
  if (operation === "input.screen_click") {
    await requireSafePoint(session, command, signal);
    if (signal.aborted) throw operationError("uncertain_outcome");
    await desktopProcess(session, "xdotool", ["mousemove", String(command.x), String(command.y), "click", "--clearmodifiers", "--repeat", command.button === "double" ? "2" : "1", "--delay", "100", command.button === "right" ? "3" : "1"], { signal });
    return { ok: true };
  }
  if (operation === "input.screen_drag") {
    await requireSafePoint(session, command, signal);
    if (signal.aborted) throw operationError("uncertain_outcome");
    const midX = String(Math.round((command.x + command.toX) / 2)), midY = String(Math.round((command.y + command.toY) / 2));
    // Moved in steps: most apps only see a drag once the pointer moves with the button held. Always released.
    try { await desktopProcess(session, "xdotool", ["mousemove", String(command.x), String(command.y), "mousedown", "1", "mousemove", midX, midY, "mousemove", String(command.toX), String(command.toY)], { signal }); }
    finally { await desktopProcess(session, "xdotool", ["mouseup", "1"]).catch(() => {}); }
    return { ok: true };
  }
  if (operation === "input.screen_scroll") {
    if (signal.aborted) throw operationError("uncertain_outcome");
    await desktopProcess(session, "xdotool", ["mousemove", String(command.x), String(command.y), "click", "--clearmodifiers", "--repeat", String(command.count), "--delay", "10", String({ up: 4, down: 5, left: 6, right: 7 }[command.direction])], { signal });
    return { ok: true };
  }
  if (operation === "input.screen_type" || operation === "input.screen_key") {
    const kind = await activeWindowKind(session, signal);
    const refusal = screenInputRefusal(kind, command.terminal);
    if (refusal) throw operationError(refusal);
    if (kind === "browser") await requireSafeFocus(session.context, signal, { needsField: operation === "input.screen_type" });
    if (signal.aborted) throw operationError("uncertain_outcome");
    if (operation === "input.screen_type") await desktopProcess(session, "xdotool", ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], { input: Buffer.from(command.text, "utf8"), signal });
    else await desktopProcess(session, "xdotool", ["key", "--clearmodifiers", "--delay", "0", command.key.split("+").map((key) => xKeys[key] ?? key).join("+")], { signal });
    return { ok: true };
  }
  if (operation === "input.select") {
    const pages = session.context.pages();
    if (pages.length > 32) throw operationError("too_many_pages");
    return selectAt(session, await choosePage(pages), command, signal);
  }
  if (operation.startsWith("input.")) {
    if (!trustedOwnerInput && (operation === "input.type" || operation === "input.key")) await requireSafeFocus(session.context, signal, { needsField: operation === "input.type" });
    if (signal.aborted) throw operationError("uncertain_outcome");
    let args, input;
    // X11 preserves the move/click order. --sync would hang if the pointer is already here.
    if (operation === "input.click") args = ["mousemove", String(command.x), String(command.y), "click", "--clearmodifiers", "--repeat", command.button === "double" ? "2" : "1", "--delay", "100", command.button === "right" ? "3" : "1"];
    else if (operation === "input.drag") {
      try { await desktopProcess(session, "xdotool", ["mousemove",String(command.x),String(command.y),"mousedown","1","mousemove",String(command.toX),String(command.toY)], {signal}); }
      finally { await desktopProcess(session,"xdotool",["mouseup","1"]).catch(()=>{}); }
      return {ok:true};
    }
    else if (operation === "input.type") { args = ["type", "--clearmodifiers", "--delay", "0", "--file", "-"]; input = Buffer.from(command.text, "utf8"); }
    else if (operation === "input.key") args = ["key", "--clearmodifiers", "--delay", "0", command.key.split("+").map((key) => xKeys[key] ?? key).join("+")];
    else args = ["click", "--clearmodifiers", "--repeat", String(command.count), "--delay", "10", String({ up: 4, down: 5, left: 6, right: 7 }[command.direction])];
    await desktopProcess(session, "xdotool", args, { input, signal });
    return { ok: true };
  }
  const pages = session.context.pages();
  if (pages.length > 32) throw operationError("too_many_pages");
  if (operation === "file.open") {
    // Only a plain, single-link outbox file of a kind the browser shows safely (see outbox-reader.mjs).
    let entry;
    try { entry = await checkOpenable(`${session.home}/outbox`, command.name); }
    catch (cause) { throw operationError(cause?.code === "type_blocked" ? "forbidden_target" : "target_not_found"); }
    if (signal.aborted) throw operationError("uncertain_outcome");
    const page = await session.context.newPage();
    try { await page.goto(`file://${session.home}/outbox/${encodeURIComponent(entry.name)}`, { timeout: OPERATION_TIMEOUT_MS, waitUntil: "commit" }); }
    catch (cause) { if (!/ERR_ABORTED|Download is starting/.test(String(cause?.message))) { await page.close().catch(() => {}); throw operationError("operation_failed"); } }
    await page.bringToFront().catch(() => {});
    return { ok: true };
  }
  if (operation === "browser.pages") return { pages: await Promise.all(pages.map(async (page) => ({
    pageId: pageId(page), href: safeHref(page.url()).slice(0, 2048), title: (await page.title()).slice(0, 1024),
  }))), source_tag: "tool", untrusted: true };
  const page = await choosePage(pages, command.pageId);
  if (operation === "browser.navigate") {
    // The browser context already sends every request through this agent's egress proxy. Once the server's response
    // commits, the outcome is known; a slow DOMContentLoaded only shortens the wait, and the step's verification
    // judges the page. A navigation that never commits fails cleanly instead of marking the session uncertain.
    const started = Date.now();
    try { await page.goto(command.url, { waitUntil: "commit", timeout: NAVIGATION_COMMIT_MS }); }
    catch { throw operationError("navigation_failed"); }
    const remaining = NAVIGATION_TIMEOUT_MS - (Date.now() - started);
    if (remaining > 0) await page.waitForLoadState("domcontentloaded", { timeout: remaining }).catch(() => {});
    return { ok: true };
  }
  if (operation === "page.find_text") return findText(page, command.text);
  if (operation === "page.snapshot" || operation === "page.verify") {
    // --sync can wait forever when already at this point. takeSnapshot awaits the measured
    // browser mouse event itself and tries another point when there was no movement.
    const move = (x, y) => desktopProcess(session, "xdotool", ["mousemove", String(x), String(y)], { signal });
    const snapshot = await takeSnapshot({ page, move, fail: operationError });
    if (signal.aborted) throw operationError("uncertain_outcome");
    if (operation === "page.verify") return { ...verifySnapshot(snapshot, command.predicate), source_tag: "tool", untrusted: true };
    return { pageId: pageId(page), href: safeHref(snapshot.url).slice(0, 2048), title: snapshot.title, frames: snapshot.frames,
      paymentFrames: snapshot.paymentFrames, elements: snapshot.elements, source_tag: "tool", untrusted: true };
  }
  const locator = page.locator(command.selector);
  if (await locator.count() !== 1) throw operationError("ambiguous_locator");
  const target = await locator.elementHandle({ timeout: OPERATION_TIMEOUT_MS, signal });
  try {
    if (!target) throw operationError("target_not_found");
    if (command.action !== "click" && (await target.evaluate(targetMetadata)).sensitive) throw operationError("sensitive_target");
    if (signal.aborted) throw operationError("uncertain_outcome");
    if (command.action === "inspect") {
      const metadata = await target.evaluate((element) => ({ tag: element.tagName.toLowerCase(), text: (element.textContent ?? "").slice(0, 4096) }));
      return { ...metadata, boundingBox: await target.boundingBox(), source_tag: "tool", untrusted: true };
    }
    if (command.action === "click") await target.click({ timeout: OPERATION_TIMEOUT_MS });
    else await target.fill(command.text, { timeout: OPERATION_TIMEOUT_MS });
    return { ok: true };
  } finally { await target?.dispose().catch(() => {}); }
}
/** Private worker boundary; schema-valid operations only, never arbitrary browser evaluation. */
export async function dispatchOperation(session, operation, params = {}, trustedOwnerInput = false) {
  if (typeof trustedOwnerInput !== "boolean") throw operationError("invalid_operation");
  if (operation === "fixture.mock_vendor") return fixtureOperation(params);
  if (!params || typeof params !== "object" || Array.isArray(params) || params.operation !== undefined && params.operation !== operation)
    throw operationError("invalid_operation");
  const parsed = OperationSchema.safeParse({ ...params, operation });
  if (!parsed.success) throw operationError("invalid_operation");
  // Visual operations need the managed browser; shell and file tools only need the sandbox. The owner's takeover input
  // is plain X11 (xdotool) on the agent's display, so it works with the browser stopped (desktop folders, terminal).
  // Agent input and input.select still require the browser.
  const ownerX11Input = trustedOwnerInput && operation.startsWith("input.") && operation !== "input.select";
  if (((operation.startsWith("input.") && !ownerX11Input) ||["window.active", "capture.screenshot", "browser.pages", "page.snapshot", "page.verify", "page.find_text", "browser.navigate", "browser.locator", "file.open", "audio.capture"].includes(operation)) && !session.context)
    throw operationError("visual_unavailable");
  if (operation === "shell.run") {
    // A long command must not mark the session uncertain, so it skips the 4 s operation bound and enforces its own timeout.
    return resultFor(operation, await performOperation(session, parsed.data, undefined, false), parsed.data);
  }
  if (operation === "audio.capture") {
    // A capture may last up to 30 s, so it gets its own bound; the module also enforces it.
    return boundedOperation(async (signal) => resultFor(operation, await performOperation(session, parsed.data, signal, false), parsed.data),
      (parsed.data.seconds + 5) * 1000);
  }
  if (operation === "browser.navigate") {
    return boundedOperation(async (signal) => resultFor(operation, await performOperation(session, parsed.data, signal, false), parsed.data),
      NAVIGATION_TIMEOUT_MS + 2000);
  }
  const command = parsed.data;
  const timeoutMs = PAGE_READS.has(operation) ? PAGE_READ_TIMEOUT_MS : CHECKED_INPUT.has(operation) ? FOCUS_INPUT_TIMEOUT_MS : OPERATION_TIMEOUT_MS;
  const run = () => boundedOperation(async (signal) => resultFor(operation, await performOperation(session, command, signal, trustedOwnerInput), command),
    timeoutMs, READ_OPERATIONS.has(operation) ? "page_busy" : "uncertain_outcome");
  return trustedOwnerInput && session.teach ? session.teach.around(command, run) : run();
}
// TASK-071. Fixtures run inside the agent namespace so Chromium can reach them on its own loopback.
let mockVendor = null;
let cookieFixture = null;
let pageFixture = null;
async function fixtureOperation(params) {
  if (process.env.ECLIPSE_FIXTURES !== "1") throw operationError("fixtures_disabled");
  const input = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const fixture = input.fixture === "cookie" ? "cookie" : input.fixture === "page" ? "page" : "vendor";
  const action = input.action;
  let state = fixture === "cookie" ? cookieFixture : fixture === "page" ? pageFixture : mockVendor;
  if (action === "start") {
    if (!state) {
      if (fixture === "cookie") {
        const { startCookieFixture } = await import("./mock-vendor/cookie-fixture.mjs");
        cookieFixture = state = await startCookieFixture();
      } else if (fixture === "page") {
        const { startPageFixture } = await import("./mock-vendor/page-fixture.mjs");
        pageFixture = state = await startPageFixture();
      } else {
        const { startMockVendor } = await import("./mock-vendor/server.mjs");
        mockVendor = state = await startMockVendor();
      }
    }
    return { source_tag: "tool", untrusted: true, url: state.url };
  }
  if (action === "status") return { source_tag: "tool", untrusted: true, url: state?.url ?? null };
  if (action === "stop") {
    await state?.close?.().catch(() => {});
    if (fixture === "cookie") cookieFixture = null; else if (fixture === "page") pageFixture = null; else mockVendor = null;
    return { source_tag: "tool", untrusted: true, stopped: true };
  }
  throw operationError("invalid_operation");
}

async function main() {
  if (process.argv[2] === "--terminate") {
    const tracked = JSON.parse(process.argv[3]); const record = sessionRecord(JSON.parse(process.argv[4]));
    if (record.uid !== process.getuid() || record.gid !== process.getgid()) fail("worker_identity_invalid");
    if (!Array.isArray(tracked) || tracked.length > 1024) fail("invalid_termination");
    for (const item of tracked.reverse()) {
      const identity = await processIdentity(item.pid);
      if (identity?.uid === process.getuid() && identity.birth === item.birth && !identity.zombie && item.pid !== process.pid) {
        try { process.kill(item.pid, "SIGKILL"); } catch { /* disappeared */ }
      }
    }
    for (let i = 0; i < 20; i++) {
      if ((await Promise.all(tracked.map((item) => processIdentity(item.pid)))).every((value) => !value || value.zombie || !tracked.some((item) => item.pid === value.pid && item.birth === value.birth))) break;
      await delay(50);
    }
    await sweepSessionProcesses(process.getuid());
    await cleanDisplay(record, tracked);
    const runtime = JSON.parse(process.argv[5] ?? "null");
    if (runtime) {
      if (!new RegExp(`^/tmp/ec-${record.uid}-[a-zA-Z0-9]{6}$`).test(runtime.path)) fail("unsafe_session_path");
      try {
        const st = await lstat(runtime.path);
        if (!st.isDirectory() || st.uid !== record.uid || st.ino !== runtime.ino || st.dev !== runtime.dev || await realpath(runtime.path) !== runtime.path) fail("unsafe_session_path");
        await rm(runtime.path, { recursive: true });
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return;
  }
  // Framed pipe mode: read from stdin, write to stdout
  // Check we have stdin/stdout available as streams (pipe mode, not IPC)
  if (process.argv.length !== 3) fail("private_ipc_required");
  const { readFramed, writeFramed } = await import("./controller-channel.mjs");
  const record = JSON.parse(process.argv[2]); let session; let stopping = false;
  const frames = readFramed(process.stdin);
  const finish = async () => {
    if (stopping) return; stopping = true;
    session?.audio?.cancel();
    session?.teach?.abort("session_stopped");
    await session?.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", () => { void finish(); }); process.once("SIGINT", () => { void finish(); });
  process.stdin.once("end", () => { void finish(); });
  process.stdin.once("close", () => { void finish(); });

  const sendMsg = (msg) => writeFramed(process.stdout, msg).catch(() => {});

  sessionRecord(record);

  session = await startSession(record, {
    onRuntime: (directory) => { void sendMsg({ state: "runtime", directory }); },
    onEvent: (event) => { void sendMsg(event); },
    autoStart: false,
  });
  if (stopping) { await session.close(); return; }
  await sendMsg({ state: "sandbox_running" });

  // Operations and lifecycle commands from the supervisor; graphics/browser start and stop are bounded here.
  try {
    let work = Promise.resolve();
    for await (const message of frames) {
      if (message?.command === "teach-abort" && Object.keys(message).length === 1) { session.teach?.abort("lease_lost"); continue; }
      if (message?.command === "capture-abort" && Object.keys(message).length === 1) { session.audio?.cancel(); continue; }
      if (message?.command === "stop" && Object.keys(message).length === 1) { session.teach?.abort("session_stopped"); void finish(); break; }
      work = work.then(async () => {
      if (message?.command === "stop" && Object.keys(message).length === 1) {
        void finish(); return;
      } else if (message?.command === "teach-abort") {
        session.teach?.abort("lease_lost");
      } else if (message?.command === "capture-abort") {
        session.audio?.cancel();
      } else if (message?.command === "teach") {
        const parsed = TeachSchema.safeParse(message.params);
        if (!parsed.success || message.requestId !== parsed.data.requestId || !session.teach) throw operationError("invalid_frame");
        try { await sendMsg({requestId:message.requestId,result:await session.teach.command(parsed.data)}); }
        catch { await sendMsg({requestId:message.requestId,error:{code:"operation_failed",message:"operation_failed"}}); }
      } else if (message?.command === "operation") {
        const parsed = WorkerOperationSchema.safeParse(message);
        if (!parsed.success) throw operationError("invalid_frame");
        const { requestId, operation, params, ownerInput } = parsed.data;
        try {
          const result = await dispatchOperation(session, operation, params, ownerInput === true);
          await sendMsg({ requestId, result });
        } catch (err) {
          const safeCodes = new Set(["page_busy", "option_not_found", "terminal_requires_shell", "unknown_window", "invalid_operation", "uncertain_outcome", "desktop_command_failed", "desktop_result_too_large", "sensitive_target", "focused_target_unknown", "too_many_pages", "too_many_frames", "page_not_found", "ambiguous_locator", "target_not_found", "navigation_failed", "grounding_unavailable", "visual_unavailable", "audio_unavailable", "audio_capture_failed", "capture_cancelled", "invalid_audio"]);
          const code = safeCodes.has(err?.code) ? err.code : err?.name === "TimeoutError" ? "uncertain_outcome" : "operation_failed";
          await sendMsg({ requestId, error: { code, message: code } });
        }
      } else if (["desktop.start", "desktop.stop", "browser.start", "browser.stop"].includes(message?.command)) {
        if (Object.keys(message).length !== 2 || typeof message.requestId !== "string") throw operationError("invalid_frame");
        const method = { "desktop.start": "startDesktop", "desktop.stop": "stopDesktop", "browser.start": "startBrowser", "browser.stop": "stopBrowser" }[message.command];
        try {
          const result = await session[method]();
          await sendMsg({ requestId: message.requestId, result });
        } catch (error) {
          const code = SESSION_FAILURES.has(error?.message) ? error.message : "operation_failed";
          await sendMsg({ requestId: message.requestId, error: { code, message: code } });
        }
      } else throw operationError("invalid_frame");
      }).catch(() => { void finish(); });
    }
    await work;
  } catch {
    // stdin ended or errored
    void finish();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  const reason = SESSION_FAILURES.has(error.message) ? error.message : "session_start_failed";
  // Use framed pipe to send failure (stdout), then exit
  import("./controller-channel.mjs").then(({ writeFramed }) => {
    writeFramed(process.stdout, { state: "failed", reason }).catch(() => {}).finally(() => process.exit(1));
  }).catch(() => process.exit(1));
});
