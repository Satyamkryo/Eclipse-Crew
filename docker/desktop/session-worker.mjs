import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, unlink, readdir, realpath, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateIds, validateRegistry } from "./agent-store.mjs";
import { OperationSchema, resultFor, validatePng, uuid } from "./controller-schema.mjs";

const fail = (code) => { throw Error(code); };
export const SESSION_FAILURES = new Set(["invalid_session_record", "agent_not_ready", "worker_identity_invalid", "worker_capabilities_invalid", "worker_security_invalid", "unsafe_session_path", "profile_busy_or_unsafe", "display_conflict", "xauthority_failed", "display_start_failed", "display_authentication_failed", "window_manager_start_failed", "browser_start_failed", "session_component_failed", "session_start_failed", "private_ipc_required"]);
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
export async function startSession(input, { onFailure = () => {}, onRuntime = () => {} } = {}) {
  const record = sessionRecord(input); const uid = process.getuid();
  if (uid !== record.uid || process.getgid() !== record.gid || process.getgroups().some((group) => group !== record.gid)) fail("worker_identity_invalid");
  const status = await readFile("/proc/self/status", "utf8");
  for (const field of ["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"]) if (!new RegExp(`^${field}:\\s+0+$`, "m").test(status)) fail("worker_capabilities_invalid");
  if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status) || +/^Seccomp_filters:\s+(\d+)/m.exec(status)?.[1] < 2) fail("worker_security_invalid");
  await privateDirectory(record.home, uid); await privateDirectory(`${record.home}/.config`, uid);
  const profile = `${record.home}/.config/chromium`; await privateDirectory(profile, uid); await privateDirectory(record.downloads, uid);
  await recoverProfile(profile, uid);
  // A conflicting X server is never removed or adopted.
  for (const name of [`/tmp/.X${record.display}-lock`, `/tmp/.X11-unix/X${record.display}`]) {
    try { await lstat(name); fail("display_conflict"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const directory = await mkdtemp(runtimePrefix(record.uid)); const original = await lstat(directory);
  onRuntime(directory);
  const authority = `${directory}/Xauthority`; const children = []; let context; let closing = false; let ready = false;
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: record.home, USER: record.name, LOGNAME: record.name, LANG: "C.UTF-8",
    DISPLAY: `:${record.display}`, XAUTHORITY: authority, XDG_RUNTIME_DIR: `${directory}/runtime`, TMPDIR: directory };
  const command = (executable, args, extra = {}) => spawnSync(executable, args, { env, stdio: "ignore", timeout: 1000, ...extra });
  const start = (executable, args) => {
    const child = spawn(executable, args, { env, stdio: "ignore", shell: false }); children.push(child);
    child.once("error", () => { if (!closing) onFailure("session_component_failed"); });
    child.once("exit", () => { if (ready && !closing) onFailure("session_component_failed"); }); return child;
  };
  const until = async (probe, code) => {
    for (let i = 0; i < 60; i++) { if (children.some((c) => c.exitCode !== null || c.signalCode !== null)) fail(code); if (probe()) return; await delay(100); }
    fail(code);
  };
  const close = async () => {
    if (closing) return; closing = true;
    if (context) await Promise.race([context.close().catch(() => {}), delay(3000)]);
    for (const child of [...children].reverse()) { try { child.kill("SIGTERM"); } catch { /* already stopped */ } }
    for (let i = 0; i < 20 && children.some((c) => c.exitCode === null && c.signalCode === null); i++) await delay(50);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* already stopped */ } }
    for (let i = 0; i < 20 && children.some((c) => c.exitCode === null && c.signalCode === null); i++) await delay(50);
    await cleanDisplay(record, children.map((child) => ({ pid: child.pid })));
    const st = await lstat(directory);
    if (st.isDirectory() && st.uid === uid && st.ino === original.ino && await realpath(directory) === directory) await rm(directory, { recursive: true });
  };
  try {
    await mkdir(`${directory}/runtime`, { mode: 0o700 }); await writeFile(authority, "", { flag: "wx", mode: 0o600 });
    const result = command("xauth", ["-f", authority], { input: `add :${record.display} MIT-MAGIC-COOKIE-1 ${randomBytes(16).toString("hex")}\n`, stdio: ["pipe", "ignore", "ignore"] });
    if (result.status !== 0) fail("xauthority_failed");
    start("Xvfb", [`:${record.display}`, "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-auth", authority, "-noreset"]);
    await until(() => command("xdpyinfo", []).status === 0, "display_start_failed");
    if (command("xdpyinfo", [], { env: { ...env, XAUTHORITY: `${directory}/absent` } }).status === 0) fail("display_authentication_failed");
    start("openbox", ["--sm-disable"]);
    await until(() => /window id # 0x[1-9a-f]/i.test(command("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? ""), "window_manager_start_failed");
    const { chromium } = await import("playwright-core");
    try { context = await chromium.launchPersistentContext(profile, { executablePath: "/opt/chromium/chrome-linux/chrome", chromiumSandbox: true,
      headless: false, viewport: null, env, downloadsPath: record.downloads, timeout: 15000,
      args: ["--window-position=0,0", "--window-size=1024,768", "--disable-dev-shm-usage", "--disable-background-networking", "--no-first-run"] }); }
    catch (cause) { throw Error("browser_start_failed", { cause }); }
    context.once("close", () => { if (!closing) onFailure("session_component_failed"); }); ready = true;
    return { context, env, display: record.display, directory, close };
  } catch (e) { await close().catch(() => {}); throw e; }
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
const pageIds = new WeakMap();
const operationError = (code) => Object.assign(Error(code), { code });
function pageId(page) {
  if (!pageIds.has(page)) pageIds.set(page, randomUUID());
  return pageIds.get(page);
}
function boundedOperation(run) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(operationError("uncertain_outcome")); }, OPERATION_TIMEOUT_MS);
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
  if (focusCheck && !document.hasFocus()) return { focused: false, sensitive: false };
  let target = focusCheck ? document.activeElement : element;
  while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  if (!target || focusCheck && ["IFRAME", "FRAME"].includes(target.tagName)) return { focused: false, sensitive: false };
  const get = (name) => (target.getAttribute?.(name) ?? "").toLowerCase();
  const type = String(target.type ?? "").toLowerCase();
  const autocomplete = get("autocomplete").split(/\s+/);
  const semantics = [get("name"), get("id"), get("aria-label")].join(" ");
  const numericCode = get("inputmode") === "numeric" && target.maxLength >= 4 && target.maxLength <= 8;
  return { focused: focusCheck, sensitive: type === "password" || autocomplete.some((value) => ["one-time-code", "current-password", "new-password"].includes(value)) ||
    /password|passwd|passcode|(?:^|[\s_-])(?:otp|totp)(?:$|[\s_-])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/.test(semantics) || numericCode };
}
function shadowTargetMetadata() {
  if (!document.hasFocus()) return { focused: false, sensitive: false };
  let focused = false;
  for (const root of this) {
    let target = root.activeElement;
    while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
    if (!target) continue;
    focused = true;
    const get = (name) => (target.getAttribute?.(name) ?? "").toLowerCase();
    const type = String(target.type ?? "").toLowerCase();
    const autocomplete = get("autocomplete").split(/\s+/);
    const semantics = [get("name"), get("id"), get("aria-label")].join(" ");
    const numericCode = get("inputmode") === "numeric" && target.maxLength >= 4 && target.maxLength <= 8;
    const sensitive = type === "password" || autocomplete.some((value) => ["one-time-code", "current-password", "new-password"].includes(value)) ||
      /password|passwd|passcode|(?:^|[\s_-])(?:otp|totp)(?:$|[\s_-])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/.test(semantics) || numericCode;
    if (sensitive) return { focused: true, sensitive: true };
  }
  return { focused, sensitive: false };
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
    let focused = false;
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
      const prototype = await session.send("Runtime.evaluate", { expression: "ShadowRoot.prototype", contextId });
      if (!prototype.result.objectId) return { focused: false, sensitive: false };
      try {
        const roots = await session.send("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId });
        if (!roots.objects.objectId) return { focused: false, sensitive: false };
        state = await readMetadata(roots.objects.objectId, shadowTargetMetadata.toString());
        if (state.sensitive) return state;
        focused ||= state.focused;
      } finally { await session.send("Runtime.releaseObject", { objectId: prototype.result.objectId }).catch(() => {}); }
    }
    return { focused, sensitive: false };
  } finally {
    session.off("Runtime.executionContextCreated", onContext);
    await session.detach().catch(() => {});
  }
}
async function requireSafeFocus(context, signal) {
  if (signal.aborted) throw operationError("uncertain_outcome");
  let focused = false;
  const pages = context.pages();
  if (pages.length > 32) throw operationError("too_many_pages");
  for (const page of pages) {
    const state = await focusedTargetMetadata(page);
    if (state.sensitive) throw operationError("sensitive_target");
    focused ||= state.focused;
    if (signal.aborted) throw operationError("uncertain_outcome");
  }
  if (!focused) throw operationError("focused_target_unknown");
}
const xKeys = { Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "super", Enter: "Return", Space: "space", Backspace: "BackSpace",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", PageUp: "Prior", PageDown: "Next" };
async function performOperation(session, command, signal) {
  const { operation } = command;
  if (operation === "capture.screenshot") {
    const crop = command.crop;
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-video_size", "1024x768", "-i", session.env.DISPLAY,
      "-frames:v", "1", "-threads", "1", "-filter_threads", "1"];
    if (crop) args.push("-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
    args.push("-f", "image2pipe", "-vcodec", "png", "pipe:1");
    const png = await desktopProcess(session, "ffmpeg", args, { maxOutput: 4 * 1024 * 1024, signal });
    const dimensions = validatePng(png, crop ?? { width: 1024, height: 768 });
    return { ...dimensions, base64: png.toString("base64"), source_tag: "tool", untrusted: true };
  }
  if (operation.startsWith("input.")) {
    if (operation === "input.type" || operation === "input.key") await requireSafeFocus(session.context, signal);
    if (signal.aborted) throw operationError("uncertain_outcome");
    let args, input;
    if (operation === "input.click") args = ["mousemove", "--sync", String(command.x), String(command.y), "click", "--clearmodifiers", "--repeat", command.button === "double" ? "2" : "1", "--delay", "100", command.button === "right" ? "3" : "1"];
    else if (operation === "input.type") { args = ["type", "--clearmodifiers", "--file", "-"]; input = Buffer.from(command.text, "utf8"); }
    else if (operation === "input.key") args = ["key", "--clearmodifiers", "--delay", "0", command.key.split("+").map((key) => xKeys[key] ?? key).join("+")];
    else args = ["click", "--clearmodifiers", "--repeat", String(command.count), "--delay", "10", String({ up: 4, down: 5, left: 6, right: 7 }[command.direction])];
    await desktopProcess(session, "xdotool", args, { input, signal });
    return { ok: true };
  }
  const pages = session.context.pages();
  if (pages.length > 32) throw operationError("too_many_pages");
  if (operation === "browser.pages") return { pages: await Promise.all(pages.map(async (page) => ({
    pageId: pageId(page), href: safeHref(page.url()).slice(0, 2048), title: (await page.title()).slice(0, 1024),
  }))), source_tag: "tool", untrusted: true };
  let page;
  if (command.pageId) page = pages.find((candidate) => pageId(candidate) === command.pageId);
  else if (pages.length === 1) page = pages[0];
  else {
    for (const candidate of pages) if (await candidate.evaluate(() => document.hasFocus())) { page = candidate; break; }
  }
  if (!page) throw operationError("page_not_found");
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
export async function dispatchOperation(session, operation, params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params) || params.operation !== undefined && params.operation !== operation)
    throw operationError("invalid_operation");
  const parsed = OperationSchema.safeParse({ ...params, operation });
  if (!parsed.success) throw operationError("invalid_operation");
  const command = parsed.data;
  return boundedOperation(async (signal) => resultFor(operation, await performOperation(session, command, signal), command));
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
  let vnc = null, vncStarting = null;
  const vncAbort = new AbortController();
  const closeVnc = async () => { try { await vnc?.close(); } catch { /* */ } vnc = null; };
  const finish = async () => {
    if (stopping) return; stopping = true;
    vncAbort.abort();
    await vncStarting?.catch(() => {});
    await closeVnc();
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
    onFailure: () => { void sendMsg({ state: "failed", reason: "session_component_failed" }).then(() => finish()); },
  });
  if (stopping) { await session.close(); return; }

  try {
    const { startVnc } = await import("./vnc-session.mjs");
    vncStarting = startVnc({ directory: session.directory, display: session.display, signal: vncAbort.signal,
      onFailure: () => { void sendMsg({ state: "failed", reason: "session_component_failed" }).then(() => finish()); } });
    vnc = await vncStarting; vncStarting = null;
    if (stopping) { await closeVnc(); return; }
    // Private framed pipe only; the root manager never includes this password in status.
    await sendMsg({ state: "vnc_ready", vncPort: vnc.vncPort, password: vnc.password });
  } catch {
    await sendMsg({ state: "failed", reason: "session_component_failed" });
    await finish(); return;
  }

  await sendMsg({ state: "running" });

  // Now listen for operation commands from supervisor via stdin
  try {
    for await (const message of readFramed(process.stdin)) {
      if (message?.command === "stop" && Object.keys(message).length === 1) {
        void finish(); break;
      } else if (message?.command === "operation" &&
        Object.keys(message).sort().join() === "command,operation,params,requestId" && uuid.safeParse(message.requestId).success) {
        const { requestId, operation, params } = message;
        try {
          const result = await dispatchOperation(session, operation, params);
          await sendMsg({ requestId, result });
        } catch (err) {
          const safeCodes = new Set(["invalid_operation", "uncertain_outcome", "desktop_command_failed", "desktop_result_too_large", "sensitive_target", "focused_target_unknown", "too_many_pages", "too_many_frames", "page_not_found", "ambiguous_locator", "target_not_found"]);
          const code = safeCodes.has(err?.code) ? err.code : err?.name === "TimeoutError" ? "uncertain_outcome" : "operation_failed";
          await sendMsg({ requestId, error: { code, message: code } });
        }
      } else throw operationError("invalid_frame");
    }
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
