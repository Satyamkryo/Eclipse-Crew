import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createCipheriv } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROMIUM, checkTools } from "./check-tools.mjs";

const summary = { task: "TASK-010", outcome: "incomplete", checks: [], stage: "identity" };
const children = []; let browser; let directory; let env; let cookie;
function requireCheck(ok, code) { if (!ok) throw Error(code); }
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 15000, maxBuffer: 512 * 1024, ...options });
  requireCheck(result.status === 0, "smoke_command_failed"); return result.stdout;
}
function start(executable, args) {
  const child = spawn(executable, args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", () => {}); child.on("error", () => {});
  children.push(child); return child;
}
async function until(check, code) {
  for (let i = 0; i < 50; i++) { try { if (await check()) return; } catch { /* bounded startup poll */ } await delay(100); }
  throw Error(code);
}
function passed(name) { summary.checks.push({ name, passed: true }); }
function rfbSocket() {
  const socket = net.connect({ host: "127.0.0.1", port: 5901 });
  let buffer = Buffer.alloc(0); let closed = false; let failed = false;
  socket.on("data", (value) => { buffer = Buffer.concat([buffer, value]); if (buffer.length > 4096) { failed = true; socket.destroy(); } });
  socket.on("close", () => { closed = true; }); socket.on("error", () => { failed = true; });
  return { socket, get closed() { return closed; }, async read(bytes) {
    await until(() => buffer.length >= bytes || closed || failed, "rfb_timeout");
    requireCheck(buffer.length >= bytes, "rfb_closed"); const value = buffer.subarray(0, bytes); buffer = buffer.subarray(bytes); return value;
  } };
}
const deadline = setTimeout(() => {
  for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ } }
  console.error(JSON.stringify({ task: "TASK-010", outcome: "incomplete", reason: "smoke_timeout" })); process.exit(1);
}, 110000);

try {
  requireCheck(process.getuid() === 65534 && process.getgid() === 65534, "identity_invalid");
  const status = await readFile("/proc/self/status", "utf8");
  requireCheck(/^CapEff:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status), "privilege_invalid");
  requireCheck(spawnSync("sudo", ["-n", "true"]).error?.code === "ENOENT", "sudo_present");
  const ordinaryChroot = spawnSync("chroot", ["/tmp", "/bin/true"], { encoding: "utf8", timeout: 1000 });
  requireCheck(ordinaryChroot.status === 125 && /Operation not permitted/.test(ordinaryChroot.stderr), "outer_chroot_not_denied");
  summary.versions = await checkTools(); passed("tool_inventory_and_nonroot_identity");
  directory = await mkdtemp("/tmp/eclipse-smoke-"); await mkdir(path.join(directory, "runtime"), { mode: 0o700 });
  const authority = path.join(directory, "Xauthority"); await writeFile(authority, "", { mode: 0o600, flag: "wx" });
  env = { PATH: process.env.PATH, HOME: directory, DISPLAY: ":99", XAUTHORITY: authority,
    XDG_RUNTIME_DIR: path.join(directory, "runtime"), LANG: "C.UTF-8" };
  cookie = randomBytes(16).toString("hex");
  command("xauth", ["-f", authority], { input: `add :99 MIT-MAGIC-COOKIE-1 ${cookie}\n` }); cookie = undefined;
  summary.stage = "display";
  start("Xvfb", [":99", "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-auth", authority, "-noreset"]);
  await until(() => spawnSync("xdpyinfo", [], { env, timeout: 1000, stdio: "ignore" }).status === 0, "display_unavailable");
  const unauthenticated = { ...env, XAUTHORITY: path.join(directory, "absent-authority") };
  requireCheck(spawnSync("xdpyinfo", [], { env: unauthenticated, timeout: 1000, stdio: "ignore" }).status !== 0, "x11_authentication_missing");
  start("openbox", ["--sm-disable"]);
  await until(() => command("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"]).includes("window id # 0x"), "window_manager_unavailable");
  passed("authenticated_xvfb_and_openbox");

  summary.stage = "vnc";
  const password = randomBytes(4).toString("hex"); const passwordFile = path.join(directory, "vnc-auth");
  command("x11vnc", ["-storepasswd", password, passwordFile]);
  start("x11vnc", ["-display", ":99", "-auth", authority, "-rfbauth", passwordFile, "-localhost", "-rfbport", "5901", "-forever", "-shared", "-noxdamage", "-quiet"]);
  await until(() => new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 5901 });
    socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false));
  }), "vnc_unavailable");
  const rfb = rfbSocket();
  try {
    requireCheck((await rfb.read(12)).toString() === "RFB 003.008\n", "rfb_version_invalid");
    rfb.socket.write("RFB 003.008\n");
    const count = (await rfb.read(1))[0]; requireCheck(count > 0 && count < 8, "rfb_security_invalid");
    const types = await rfb.read(count);
    requireCheck(types.includes(2) && !types.includes(1), "vnc_authentication_missing");
    rfb.socket.write(Buffer.of(1)); // Deliberately request unauthenticated access, which was not offered.
    await until(() => rfb.closed, "unauthenticated_vnc_not_rejected");
  } finally { rfb.socket.destroy(); }
  const authenticated = rfbSocket();
  try {
    requireCheck((await authenticated.read(12)).toString() === "RFB 003.008\n", "rfb_version_invalid");
    authenticated.socket.write("RFB 003.008\n");
    const count = (await authenticated.read(1))[0]; requireCheck(count > 0 && count < 8, "rfb_security_invalid");
    requireCheck((await authenticated.read(count)).includes(2), "vnc_authentication_missing");
    authenticated.socket.write(Buffer.of(2));
    const challenge = await authenticated.read(16);
    // VNC's legacy DES challenge is protocol-only and uses a disposable password.
    // EDE3 with three identical keys equals DES, without OpenSSL's legacy provider.
    const key = Buffer.from(password, "ascii").map((byte) => {
      let reversed = 0; for (let bit = 0; bit < 8; bit++) reversed |= ((byte >> bit) & 1) << (7 - bit); return reversed;
    });
    const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
    authenticated.socket.write(Buffer.concat([cipher.update(challenge), cipher.final()]));
    requireCheck((await authenticated.read(4)).readUInt32BE() === 0, "vnc_authentication_failed");
    authenticated.socket.write(Buffer.of(1));
    const screen = await authenticated.read(24);
    requireCheck(screen.readUInt16BE(0) === 1024 && screen.readUInt16BE(2) === 768, "rfb_security_invalid");
  } finally { authenticated.socket.destroy(); }
  start("websockify", ["--web=/usr/share/novnc", "127.0.0.1:6081", "127.0.0.1:5901"]);
  await until(async () => {
    const response = await fetch("http://127.0.0.1:6081/vnc.html", { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.text()).includes("noVNC");
  }, "novnc_unavailable");
  await new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:6081/", ["binary"]); socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => { socket.close(); reject(Error("websocket_timeout")); }, 5000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer); socket.close();
      if (Buffer.from(event.data).toString() === "RFB 003.008\n") resolve(); else reject(Error("websocket_rfb_invalid"));
    }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("websocket_unavailable")); }, { once: true });
  });
  passed("authenticated_vnc_and_novnc_websocket_transport");

  summary.stage = "capture";
  const pngFile = path.join(directory, "screen.png"); const videoFile = path.join(directory, "screen.mp4");
  command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1024x768", "-i", ":99",
    "-frames:v", "1", "-threads", "1", pngFile]);
  const png = await readFile(pngFile);
  requireCheck(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    png.readUInt32BE(16) === 1024 && png.readUInt32BE(20) === 768, "capture_invalid");
  command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1024x768", "-framerate", "5", "-i", ":99",
    "-frames:v", "3", "-an", "-c:v", "mpeg4", videoFile]);
  const media = JSON.parse(command("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
    "stream=width,height,nb_read_frames", "-of", "json", videoFile]));
  requireCheck(media.streams?.length === 1 && media.streams[0].width === 1024 && media.streams[0].height === 768 &&
    +media.streams[0].nb_read_frames === 3, "video_invalid"); passed("x11_png_and_three_frame_video");

  summary.stage = "browser";
  try {
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: false, chromiumSandbox: true, env, timeout: 15000,
      args: ["--start-fullscreen", "--window-position=0,0", "--window-size=1024,768", "--disable-background-networking"] });
  } catch (error) {
    if (/sandbox|namespace|Operation not permitted|EPERM/i.test(error.message)) throw Error("chromium_sandbox_unavailable");
    throw Error("chromium_launch_failed");
  }
  const context = await browser.newContext({ viewport: null, acceptDownloads: false, serviceWorkers: "block", permissions: [] });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  await page.goto("chrome://sandbox/");
  const sandbox = await page.locator("body").innerText();
  const namespaceLayer = /Layer 1 Sandbox\s+Namespace|Namespace sandbox\s+Yes/i.test(sandbox);
  summary.sandbox = { namespace: namespaceLayer && /PID namespaces\s+Yes/i.test(sandbox) && /Network namespaces\s+Yes/i.test(sandbox),
    seccompBpf: /Seccomp-BPF sandbox\s+Yes/i.test(sandbox) };
  requireCheck(summary.sandbox.namespace && summary.sandbox.seccompBpf, "browser_sandbox_not_verified");
  await page.goto("about:blank");
  await page.setContent('<!doctype html><title>Desktop toolchain smoke</title><style>body{margin:0;display:grid;place-items:center;height:100vh}button{width:400px;height:240px}</style><button onclick="this.textContent=String(++window.count)">0</button><script>window.count=0</script>');
  await page.locator("button").click(); requireCheck(await page.locator("button").textContent() === "1", "playwright_input_failed");
  command("xdotool", ["mousemove", "512", "384", "click", "1"]);
  await until(async () => (await page.locator("button").textContent()) === "2", "xdotool_input_failed");
  passed("sandboxed_chromium_playwright_and_xdotool");
  await browser.close(); browser = undefined;
  summary.stage = "complete"; summary.outcome = "passed";
} catch (error) {
  const allowed = new Set(["identity_invalid", "privilege_invalid", "sudo_present", "display_unavailable", "x11_authentication_missing",
    "window_manager_unavailable", "vnc_unavailable", "rfb_version_invalid", "rfb_security_invalid", "vnc_authentication_missing",
    "unauthenticated_vnc_not_rejected", "vnc_authentication_failed", "novnc_unavailable", "websocket_timeout", "websocket_rfb_invalid", "websocket_unavailable",
    "capture_invalid", "video_invalid", "chromium_sandbox_unavailable", "chromium_launch_failed", "playwright_input_failed", "xdotool_input_failed",
    "smoke_command_failed", "rfb_timeout", "rfb_closed", "outer_chroot_not_denied", "browser_sandbox_not_verified"]);
  summary.reason = allowed.has(error.message) ? error.message : "toolchain_check_failed";
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
    await delay(100);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
  }
  cookie = undefined;
  if (directory && /^\/tmp\/eclipse-smoke-[\w-]+$/.test(directory)) await rm(directory, { recursive: true, force: true });
  clearTimeout(deadline);
}
console.log(JSON.stringify(summary)); if (summary.outcome !== "passed") process.exitCode = 1;
