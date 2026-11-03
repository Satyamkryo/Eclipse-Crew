import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { readSnapshot, sessionCookies, writeSnapshot } from "./cookie-snapshot.mjs";
import { takeSnapshot } from "./page-snapshot.mjs";

const CFT = "/opt/chrome-for-testing/chrome-linux64/chrome";
const summary = { task: "TASK-078", outcome: "incomplete", checks: [], stage: "identity" };
const children = []; let context; let directory; let env; let server;
function requireCheck(ok, code) { if (!ok) throw Error(code); }
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024, ...options });
  requireCheck(result.status === 0, "spike_command_failed"); return result.stdout;
}
function start(executable, args) {
  const child = spawn(executable, args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", () => {}); child.on("error", () => {}); children.push(child); return child;
}
async function until(check, code) {
  for (let i = 0; i < 80; i++) { try { if (await check()) return; } catch { /* bounded poll */ } await delay(100); }
  throw Error(code);
}
function passed(name) { summary.checks.push({ name, passed: true }); }
const deadline = setTimeout(() => {
  for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* stopped */ } }
  console.error(JSON.stringify({ ...summary, reason: "spike_timeout" })); process.exit(1);
}, 180000);

try {
  requireCheck(process.getuid() === 65534 && process.getgid() === 65534, "identity_invalid");
  const status = await readFile("/proc/self/status", "utf8");
  requireCheck(/^CapEff:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status), "privilege_invalid");
  directory = await mkdtemp("/tmp/eclipse-cft-"); await mkdir(path.join(directory, "runtime"), { mode: 0o700 });
  const authority = path.join(directory, "Xauthority"); await writeFile(authority, "", { mode: 0o600, flag: "wx" });
  env = { PATH: process.env.PATH, HOME: directory, DISPLAY: ":99", XAUTHORITY: authority,
    XDG_RUNTIME_DIR: path.join(directory, "runtime"), TMPDIR: directory, LANG: "C.UTF-8" };
  spawnSync("xauth", ["-f", authority, "add", ":99", "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], { env });
  requireCheck(spawnSync("xauth", ["-f", authority, "list"], { env, stdio: "ignore" }).status === 0, "xauthority_failed");
  start("Xvfb", [":99", "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-auth", authority, "-noreset"]);
  await until(() => spawnSync("xdpyinfo", [], { env, timeout: 1000, stdio: "ignore" }).status === 0, "display_unavailable");
  start("openbox", ["--sm-disable"]);
  await until(() => spawnSync("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], { env, encoding: "utf8" }).stdout.includes("window id # 0x"), "window_manager_unavailable");
  passed("authenticated_xvfb_and_openbox");

  summary.stage = "media";
  const media = path.join(directory, "clip.mp4");
  command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", media]);
  const mediaBytes = await readFile(media); requireCheck(mediaBytes.length > 1000, "media_invalid");
  const html = `<!doctype html><title>CfT spike</title><body style="margin:0;display:grid;place-items:center;height:100vh;gap:16px">
    <video id="v" src="/clip.mp4" autoplay muted playsinline style="width:320px;height:240px"></video>
    <button id="b" onclick="document.title='clicked'" style="width:400px;height:140px;font-size:28px">Save</button>
    <a id="d" href="/clip.mp4" download="clip.mp4">Download</a></body>`;
  server = createServer(async (request, response) => {
    if (request.url === "/") { response.setHeader("content-type", "text/html"); response.end(html); return; }
    if (request.url === "/clip.mp4") { response.setHeader("content-type", "video/mp4"); response.end(mediaBytes); return; }
    response.statusCode = 404; response.end();
  });
  await new Promise((resolve) => server.listen(18080, "127.0.0.1", resolve));
  passed("deterministic_h264_aac_fixture");

  summary.stage = "browser";
  const profile = path.join(directory, "profile"); await mkdir(profile, { mode: 0o700 });
  const downloads = path.join(directory, "downloads"); await mkdir(downloads, { mode: 0o700 });
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: CFT, chromiumSandbox: true, headless: false,
      viewport: null, acceptDownloads: true, downloadsPath: downloads, env, timeout: 20000,
      args: ["--window-position=0,0", "--window-size=1024,768", "--disable-background-networking", "--no-first-run",
        "--autoplay-policy=no-user-gesture-required"] });
  } catch (error) {
    if (/sandbox|namespace|Operation not permitted|EPERM/i.test(error.message)) throw Error("browser_sandbox_unavailable");
    throw Error("browser_launch_failed");
  }
  const page = context.pages()[0] ?? await context.newPage(); await page.bringToFront();
  await page.goto("chrome://sandbox/");
  const sandbox = await page.locator("body").innerText();
  requireCheck(/PID namespaces\s+Yes/i.test(sandbox) && /Network namespaces\s+Yes/i.test(sandbox) && /Seccomp-BPF sandbox\s+Yes/i.test(sandbox), "browser_sandbox_not_verified");
  passed("browser_namespace_and_seccomp_sandbox");

  await page.goto("http://127.0.0.1:18080/", { waitUntil: "domcontentloaded" });
  const support = await page.evaluate(() => ({
    h264: document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
    webm: document.createElement("video").canPlayType('video/webm; codecs="vp9, opus"'),
  }));
  requireCheck(support.h264 === "probably" || support.h264 === "maybe", "h264_not_supported");
  await page.evaluate(() => { const video = document.getElementById("v"); video.muted = true; return video.play().catch(() => {}); });
  await until(() => page.evaluate(() => document.getElementById("v").currentTime > 1), "h264_playback_stalled");
  const playback = await page.evaluate(() => { const video = document.getElementById("v");
    return { currentTime: video.currentTime, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
      audioBytes: typeof video.webkitAudioDecodedByteCount === "number" ? video.webkitAudioDecodedByteCount : null }; });
  requireCheck(playback.width === 320 && playback.height === 240 && playback.readyState >= 3, "h264_decode_invalid");
  requireCheck(playback.audioBytes === null || playback.audioBytes > 0, "aac_not_decoded");
  passed("real_h264_and_aac_playback");

  summary.stage = "grounding";
  const snapshot = await takeSnapshot({ page, move: (x, y) => command("xdotool", ["mousemove", String(x), String(y)]), fail: (code) => Object.assign(Error(code), { code }) });
  const save = snapshot.elements.find((element) => element.name === "Save");
  requireCheck(Boolean(save), "grounding_missing_save");
  await page.evaluate(() => { document.title = "none"; });
  command("xdotool", ["mousemove", String(save.x + Math.floor(save.width / 2)), String(save.y + Math.floor(save.height / 2)), "click", "1"]);
  let xclick = false; for (let i = 0; i < 80 && !xclick; i++) { xclick = (await page.title()) === "clicked"; if (!xclick) await delay(100); }
  if (!xclick) { summary.debug = { save, title: await page.title(), elements: snapshot.elements.map((element) => [element.name, element.x, element.y, element.width, element.height]) }; throw Error("xdotool_click_failed"); }
  await page.evaluate(() => { document.title = "none"; });
  await page.locator("#b").click(); requireCheck(await page.title() === "clicked", "playwright_click_failed");
  passed("page_structure_grounding_playwright_and_xdotool_clicks");

  summary.stage = "capture";
  const png = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1024x768", "-i", ":99",
    "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { env, maxBuffer: 4 * 1024 * 1024 }).stdout;
  requireCheck(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "screenshot_invalid");
  passed("x11_screenshot");

  const second = await context.newPage(); await second.goto("http://127.0.0.1:18080/", { waitUntil: "domcontentloaded" });
  requireCheck(context.pages().length >= 2 && (await second.title()) === "CfT spike", "multiple_tabs_failed");
  passed("multiple_tabs");

  summary.stage = "download";
  await page.bringToFront();
  const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
  await page.locator("#d").click();
  const download = await downloadPromise; const saved = path.join(directory, "downloaded.mp4"); await download.saveAs(saved);
  requireCheck((await stat(saved)).size === mediaBytes.length, "download_invalid");
  passed("download");

  summary.stage = "cookies";
  await context.addCookies([{ name: "sess", value: "A", domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Strict" }]);
  await writeSnapshot(profile, sessionCookies(await context.cookies()));
  await context.close(); context = undefined;
  context = await chromium.launchPersistentContext(profile, { executablePath: CFT, chromiumSandbox: true, headless: false, viewport: null,
    acceptDownloads: true, downloadsPath: downloads, env, timeout: 20000, args: ["--window-position=0,0", "--window-size=1024,768", "--no-first-run"] });
  const restored = await readSnapshot(profile, process.getuid()); if (restored.length) await context.addCookies(restored);
  const after = await context.cookies(); requireCheck(after.some((item) => item.name === "sess" && item.value === "A"), "session_cookie_not_restored");
  passed("persistent_profile_session_cookie_restart");

  const secondProfile = path.join(directory, "profile2"); await mkdir(secondProfile, { mode: 0o700 });
  const other = await chromium.launchPersistentContext(secondProfile, { executablePath: CFT, chromiumSandbox: true, headless: false,
    viewport: null, env, timeout: 20000, args: ["--window-position=0,0", "--window-size=1024,768", "--no-first-run"] });
  await other.addCookies([{ name: "sess", value: "B", domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Strict" }]);
  const otherCookies = await other.cookies(); await other.close();
  requireCheck(otherCookies.some((item) => item.value === "B") && !otherCookies.some((item) => item.value === "A"), "profile_cookie_leak");
  passed("second_profile_isolated_cookie");

  summary.stage = "complete"; summary.outcome = "passed"; summary.version = command(CFT, ["--version"]).trim();
} catch (error) {
  const allowed = new Set(["identity_invalid", "privilege_invalid", "xauthority_failed", "display_unavailable", "window_manager_unavailable",
    "media_invalid", "browser_sandbox_unavailable", "browser_launch_failed", "browser_sandbox_not_verified", "h264_not_supported", "h264_playback_stalled",
    "h264_decode_invalid", "aac_not_decoded", "grounding_missing_save", "xdotool_click_failed", "playwright_click_failed", "screenshot_invalid",
    "multiple_tabs_failed", "download_invalid", "session_cookie_not_restored", "profile_cookie_leak", "spike_command_failed"]);
  summary.reason = allowed.has(error.message) ? error.message : "spike_check_failed";
} finally {
  await context?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const child of children.reverse()) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* stopped */ } }
  await delay(100);
  for (const child of children.reverse()) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* stopped */ } }
  if (directory && /^\/tmp\/eclipse-cft-[\w-]+$/.test(directory)) await rm(directory, { recursive: true, force: true });
  clearTimeout(deadline);
}
console.log(JSON.stringify(summary)); if (summary.outcome !== "passed") process.exitCode = 1;
