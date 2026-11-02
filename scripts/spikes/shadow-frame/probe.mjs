// Shadow DOM and iframe grounding spike: the part that runs inside the throwaway desktop container as uid 65534.
// stdin is one JSON object of { "<fixture file>": "<contents>" }. stdout is exactly one JSON line.
// Nothing here reaches the host: no mounts, no env beyond PATH, and every step that fails is recorded as blocked.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

const DESKTOP = "/opt/eclipse/desktop";
const CHROMIUM = "/opt/chromium/chrome-linux/chrome";
const FIXTURE_ROOT = "/tmp/spike/fixtures";
const SITE_A = "http://127.0.0.1:8081";
const SITE_B = "http://localhost:8082";
const SCAN_SAMPLES = 5;
const PAGE_SETTLE_MS = 500;
const PROBE_DEADLINE_MS = 540000;
const LIVE_URLS = ["https://www.porsche.com/international/models/911/", "https://shoelace.style/components/button",
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe", "https://checkout.stripe.dev/"];
const CALIBRATION_POINTS = [{ x: 512, y: 400 }, { x: 700, y: 520 }, { x: 330, y: 300 }];
const CALIBRATION_WAIT_MS = 600;

const live = process.argv.includes("--live");
const result = { outcome: "blocked", stage: "identity", live, environment: {}, calibration: null, servers: null, fixtures: [],
  targets: [], blocked: [], errors: [] };
const children = [];
const clip = (value) => String(value ?? "").replace(/\s+/g, " ").slice(0, 300);
const block = (stage, cause) => { result.blocked.push({ stage, error: clip(cause?.message ?? cause) }); };
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] ?? null; };
const percentile95 = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : null; };

let directory = null, browser = null, env = null;

function command(executable, args, options = {}) {
  return spawnSync(executable, args, { env, encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...options });
}
function start(executable, args) {
  const child = spawn(executable, args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", () => {});
  child.on("error", (cause) => block("display", cause));
  children.push(child);
  return child;
}
async function until(check, code) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if (await check()) return true; } catch { /* bounded start-up poll */ }
    await delay(100);
  }
  throw Error(code);
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
const servers = [];
function serve(host, port, root) {
  const server = http.createServer((request, response) => {
    let name = "";
    try {
      const url = new URL(request.url, `${SITE_A}/`);
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes("..") || decoded.includes("\0")) throw Error("traversal");
      name = path.basename(decoded === "/" ? "baseline.html" : decoded);
      if (!name.endsWith(".html")) throw Error("not_html");
      const file = path.join(root, name);
      readFile(file, "utf8").then((text) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(text);
      }).catch(() => { response.writeHead(404, { "Content-Type": "text/plain" }); response.end("absent"); });
    } catch { response.writeHead(400, { "Content-Type": "text/plain" }); response.end("refused"); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => resolve({ host, port, address: server.address().address, family: server.address().family }));
    server.on("close", () => {});
    server.keepAliveTimeout = 1000;
    servers.push(server);
  });
}
async function stopServers() { for (const server of servers) await new Promise((resolve) => server.close(resolve)); }

async function main() {
  const startedAt = performance.now();
  const pastDeadline = () => performance.now() - startedAt > PROBE_DEADLINE_MS;

  // 1. Identity, fixtures on disk, display.
  result.stage = "identity";
  if (typeof process.getuid === "function") result.environment.uid = `${process.getuid()}:${process.getgid()}`;
  const payload = JSON.parse(await readStdin());
  const entries = Object.entries(payload).filter(([name]) => /^[\w.-]+\.(html|json)$/.test(name));
  await mkdir(FIXTURE_ROOT, { recursive: true, mode: 0o755 });
  for (const [name, content] of entries) await writeFile(path.join(FIXTURE_ROOT, name), String(content), { mode: 0o644 });
  const cases = JSON.parse(await readFile(path.join(FIXTURE_ROOT, "cases.json"), "utf8"));
  result.environment.fixturesReceived = entries.filter(([name]) => name.endsWith(".html")).length;
  result.environment.casesReceived = cases.length;

  directory = await mkdtemp("/tmp/eclipse-spike-");
  await mkdir(path.join(directory, "runtime"), { mode: 0o700 });
  await mkdir(path.join(directory, "profile"), { mode: 0o700 });
  const authority = path.join(directory, "Xauthority");
  await writeFile(authority, "", { mode: 0o600, flag: "wx" });
  env = { PATH: process.env.PATH, HOME: directory, DISPLAY: ":99", XAUTHORITY: authority,
    XDG_RUNTIME_DIR: path.join(directory, "runtime"), LANG: "C.UTF-8" };
  result.stage = "display";
  const cookie = randomBytes(16).toString("hex");
  if (command("xauth", ["-f", authority], { input: `add :99 MIT-MAGIC-COOKIE-1 ${cookie}\n` }).status !== 0) throw Error("xauth_failed");
  start("Xvfb", [":99", "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-auth", authority, "-noreset"]);
  await until(() => command("xdpyinfo", []).status === 0, "display_unavailable");
  start("openbox", ["--sm-disable"]);
  await until(() => /window id # 0x/i.test(command("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"]).stdout ?? ""), "window_manager_unavailable");
  result.environment.display = "xvfb-1024x768x24+openbox";

  // 2. Two sites, so a cross-site frame is really a different site.
  result.stage = "servers";
  const siteA = await serve("127.0.0.1", 8081, FIXTURE_ROOT);
  const siteB = await serve("localhost", 8082, FIXTURE_ROOT);
  const reachable = async (base, file) => { try { const response = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(2000) }); return response.ok; } catch { return false; } };
  result.servers = { siteA, siteB, siteAOk: await reachable(SITE_A, "baseline.html"), siteBOk: await reachable(SITE_B, "_frame-cross.html") };
  if (!result.servers.siteAOk || !result.servers.siteBOk) throw Error("fixture_servers_unreachable");

  // 3. Chromium the way the desktop session launches it, sandbox on.
  result.stage = "chromium";
  const { chromium } = await import(`${DESKTOP}/node_modules/playwright-core/index.mjs`);
  const pageSnapshot = await import(`${DESKTOP}/page-snapshot.mjs`);
  const { installCalibration, scanPage, verifySnapshot } = pageSnapshot;
  const scanners = await import("/tmp/scanners.mjs");
  result.environment.chromiumExecutable = CHROMIUM;
  try {
    browser = await chromium.launchPersistentContext(path.join(directory, "profile"), {
      executablePath: CHROMIUM, chromiumSandbox: true, headless: false, viewport: null, env, timeout: 30000,
      args: ["--window-position=0,0", "--window-size=1024,768", "--disable-dev-shm-usage", "--disable-background-networking", "--no-first-run"] });
  } catch (cause) {
    const failure = Error("chromium_launch_failed");
    failure.detail = clip(cause);
    throw failure;
  }
  const page = browser.pages()[0] ?? await browser.newPage();
  await page.goto(`${SITE_A}/baseline.html`, { waitUntil: "load" });
  await delay(PAGE_SETTLE_MS);

  // 4. Calibrate the viewport's screen origin with real pointer moves, exactly as takeSnapshot does.
  result.stage = "calibration";
  const cdp = await browser.newCDPSession(page);
  for (const point of CALIBRATION_POINTS) {
    const handle = await page.evaluateHandle(installCalibration, CALIBRATION_WAIT_MS);
    let sample = null;
    try {
      command("xdotool", ["mousemove", String(point.x), String(point.y)]);
      sample = await handle.evaluate((value) => value.result);
    } finally { await handle.dispose().catch(() => {}); }
    if (!sample) continue;
    if (sample.ratio !== 1 || sample.scale !== 1) { result.calibration = { ok: false, reason: "scaled_page" }; break; }
    if (sample.screenX !== point.x || sample.screenY !== point.y) { result.calibration = { ok: false, reason: "pointer_mismatch", sample }; break; }
    const origin = { x: sample.screenX - sample.clientX, y: sample.screenY - sample.clientY };
    result.calibration = { ok: true, origin, point, viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight })) };
    break;
  }
  if (!result.calibration?.ok) throw Error("calibration_failed");
  const origin = result.calibration.origin;
  const screen = scanners.SCREEN;

  // 5. Scanners over every fixture.
  result.stage = "fixtures";
  const runScanners = async () => ({
    current: await scanners.scanCurrent({ scanPage, page, origin, screen, limit: scanners.LIMIT }),
    A: await scanners.scanA({ page, origin, screen, limit: scanners.LIMIT }),
    B: await scanners.scanB({ context: browser, page, origin, screen, limit: scanners.LIMIT }),
  });
  const nameSet = (controls) => new Set(controls.map((control) => control.name));
  const clickReader = async () => {
    const perFrame = await Promise.all(page.frames().map(async (frame) => {
      try { return await frame.evaluate(() => Array.isArray(window.__spikeClicks) ? window.__spikeClicks : []); } catch { return null; }
    }));
    return perFrame;
  };
  const fixtureFiles = [...new Set(cases.map((entry) => entry.fixture))];
  for (const fixture of fixtureFiles) {
    if (pastDeadline()) { result.fixtures.push({ fixture, outcome: "blocked", reason: "probe_deadline" }); block("fixture", `probe_deadline ${fixture}`); continue; }
    const entry = { fixture, outcome: "complete", url: `${SITE_A}/${fixture}`, scans: {}, timings: {}, clicks: {}, verify: {}, errors: [] };
    try {
      await page.goto(entry.url, { waitUntil: "load" });
      await delay(PAGE_SETTLE_MS);
      const iframeTargets = async () => {
        const { targetInfos } = await cdp.send("Target.getTargets");
        return targetInfos.filter((info) => info.type === "iframe").map((info) => clip(info.url).slice(0, 120));
      };
      entry.outOfProcessFrames = await iframeTargets().catch((cause) => { entry.errors.push(`targets:${clip(cause)}`); return null; });
      const samples = { current: [], A: [], B: [] };
      const last = {};
      for (let run = 0; run < SCAN_SAMPLES; run++) {
        const scanned = await runScanners();
        for (const key of ["current", "A", "B"]) { samples[key].push(scanned[key].ms); last[key] = scanned[key]; }
      }
      for (const key of ["current", "A", "B"]) {
        const scan = last[key];
        entry.scans[key] = { frames: scan.frames, scannedFrames: scan.scannedFrames, paymentFrames: scan.paymentFrames, truncated: !!scan.truncated,
          found: scan.controls.map((control) => ({ name: control.name, role: control.role, frame: control.frame, shadow: control.shadow,
            x: control.x, y: control.y, width: control.width, height: control.height, centreX: control.centreX, centreY: control.centreY,
            centreOffscreen: !!control.centreOffscreen })),
          counts: { controls: scan.controls.length, ...(scan.shadowNodes === undefined ? {} : { shadowNodes: scan.shadowNodes, deepestShadowDepth: scan.deepestShadowDepth }),
            ...(scan.noCoordinates === undefined ? {} : { noCoordinates: scan.noCoordinates, markupUnknown: scan.markupUnknown, duplicates: scan.duplicates, axNodes: scan.axNodes }),
            ...(scan.errors?.length ? { errors: scan.errors.map(clip) } : {}) } };
        entry.timings[key] = { samples: samples[key], median: median(samples[key]), p95: percentile95(samples[key]) };
      }

      // 7. Click test: reload, one real pointer click, and only the expected target may have recorded it.
      for (const key of ["current", "A", "B"]) {
        const found = nameSet(entry.scans[key].found);
        const targets = cases.filter((item) => item.fixture === fixture && item.expect === "listed" && found.has(item.name));
        const outcomes = [];
        for (const target of targets) {
          if (pastDeadline()) { outcomes.push({ name: target.name, skipped: "probe_deadline" }); break; }
          const control = entry.scans[key].found.find((item) => item.name === target.name);
          await page.goto(entry.url, { waitUntil: "load" });
          await delay(PAGE_SETTLE_MS);
          if (control.centreOffscreen) { outcomes.push({ name: target.name, centre: [control.centreX, control.centreY], ok: false, reason: "centre_offscreen" }); continue; }
          command("xdotool", ["mousemove", String(control.centreX), String(control.centreY), "click", "1"]);
          await delay(150);
          const perFrame = await clickReader();
          const recorded = perFrame.flat().filter(Boolean);
          outcomes.push({ name: target.name, role: target.role, frame: target.frame, centre: [control.centreX, control.centreY],
            perFrame: perFrame.map((values) => values === null ? null : values), recorded, ok: recorded.length === 1 && recorded[0] === target.name });
        }
        entry.clicks[key] = { expected: targets.length, results: outcomes, landed: outcomes.filter((item) => item.ok).length };
      }

      // 8. Verification test with the production predicate rules.
      for (const key of ["current", "A", "B"]) {
        const present = cases.filter((item) => item.fixture === fixture && item.expect === "listed" && entry.scans[key].found.some((control) => control.name === item.name)).slice(0, 3);
        const presentResults = present.map((item) => ({ name: item.name, ...verifySnapshot({ elements: entry.scans[key].found.map((control) => ({ name: control.name })) },
          { kind: "control_present", value: item.name }) }));
        entry.verify[key] = { controlPresent: presentResults, controlAbsent: null };
      }
      if (fixture === "obstruction.html") {
        for (const key of ["current", "A", "B"]) {
          const remover = entry.scans[key].found.find((control) => control.name === "Remove target");
          if (!remover) { entry.verify[key].controlAbsent = { status: "blocked", code: "remove_target_not_found" }; continue; }
          await page.goto(entry.url, { waitUntil: "load" });
          await delay(PAGE_SETTLE_MS);
          command("xdotool", ["mousemove", String(remover.centreX), String(remover.centreY), "click", "1"]);
          await delay(250);
          const rescanned = (await runScanners())[key];
          entry.verify[key].controlAbsent = verifySnapshot({ elements: rescanned.controls.map((control) => ({ name: control.name })) },
            { kind: "control_absent", value: "Removed target" });
        }
      }
    } catch (cause) {
      entry.outcome = "blocked";
      entry.reason = clip(cause);
      block(`fixture:${fixture}`, cause);
    }
    result.fixtures.push(entry);
  }

  // 6. Out-of-process confirmation is recorded per fixture above; summarise it here.
  const crossSite = result.fixtures.filter((entry) => (entry.outOfProcessFrames ?? []).some((url) => url.includes("localhost:8082")));
  const expectedCrossSite = result.fixtures.filter((entry) => cases.some((item) => item.fixture === entry.fixture && item.frame === "cross-site"));
  result.targets = { method: "CDP Target.getTargets, type iframe, per fixture",
    fixturesWithCrossSiteTarget: crossSite.map((entry) => entry.fixture), expectedCrossSiteFixtures: expectedCrossSite.map((entry) => entry.fixture),
    confirmed: expectedCrossSite.length > 0 && crossSite.length === expectedCrossSite.length,
    targetUrlsByFixture: Object.fromEntries(result.fixtures.map((entry) => [entry.fixture, entry.outOfProcessFrames ?? []])) };

  // Optional live phase: read-only scans of real pages, never clicks or typing.
  if (live) {
    result.live = [];
    for (const url of LIVE_URLS) {
      const pageResult = { url, outcome: "unreachable" };
      try {
        const response = await page.goto(url, { waitUntil: "load", timeout: 30000 });
        pageResult.status = response ? response.status() : null;
        await delay(PAGE_SETTLE_MS);
        const scanned = await runScanners();
        const final = await runScanners();
        pageResult.outcome = "scanned";
        pageResult.outOfProcessFrames = (await cdp.send("Target.getTargets")).targetInfos.filter((info) => info.type === "iframe").length;
        for (const key of ["current", "A", "B"]) pageResult[key] = { controls: final[key].controls.length, frames: final[key].frames,
          paymentFrames: final[key].paymentFrames, p95: percentile95([scanned[key].ms, final[key].ms]),
          names: final[key].controls.slice(0, 12).map((control) => control.name) };
      } catch (cause) {
        pageResult.outcome = "unreachable";
        pageResult.error = clip(cause);
      }
      result.live.push(pageResult);
    }
  }
  result.outcome = result.blocked.length ? "partial" : "complete";
}

try {
  await main();
} catch (cause) {
  const reason = cause?.message === "chromium_launch_failed" ? "chromium_launch_failed"
    : /^calibration_failed$|^display_unavailable$|^window_manager_unavailable$|^fixture_servers_unreachable$/.test(String(cause?.message ?? "")) ? String(cause.message)
      : result.fixtures.length ? "probe_failed_after_fixtures" : "probe_failed";
  result.outcome = result.fixtures.length && reason === "probe_failed_after_fixtures" ? "partial" : "blocked";
  result.reason = reason;
  result.detail = clip(cause?.detail ?? cause);
  block("probe", cause);
} finally {
  await delay(200);
  await browser?.close().catch(() => {});
  await stopServers().catch(() => {});
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ }
    await delay(80);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
  }
  if (directory && /^\/tmp\/eclipse-spike-[\w-]+$/.test(directory)) await rm(directory, { recursive: true, force: true }).catch(() => {});
}

// stdout is a pipe here, so the line must be flushed before the process may exit.
let payload;
try { payload = JSON.stringify(result); }
catch (cause) { payload = JSON.stringify({ outcome: "blocked", reason: "result_unserializable", stage: result.stage, error: clip(cause) }); }
const flushed = (code) => process.exit(code);
process.stdout.write(`${payload}\n`, () => flushed(0));
setTimeout(() => flushed(0), 5000).unref();
