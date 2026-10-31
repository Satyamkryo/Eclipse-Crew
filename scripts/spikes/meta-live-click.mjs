import "server-only";
import nextEnv from "@next/env";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { LOCAL_PAGE, LiveClickError, REVIEW_TIMEOUT_MS, hash, validateViewportGeometry, reservePrivateDirectory, runLiveClick } from "./meta-live-click-core.mjs";

export function waitForOwnerReview(info, { input = process.stdin, emit = (value) => console.log(JSON.stringify(value)) } = {}) {
  return new Promise((resolve) => {
    if (info.signal.aborted) { resolve(false); return; }
    const reviewToken = randomUUID();
    const reader = createInterface({ input, terminal: false });
    let settled = false;
    const finish = (approved) => {
      if (settled) return; settled = true;
      info.signal.removeEventListener("abort", abort);
      reader.close(); resolve(approved);
    };
    const abort = () => finish(false);
    info.signal.addEventListener("abort", abort, { once: true });
    reader.once("close", () => finish(false));
    reader.once("line", (line) => finish(line === `APPROVE ${reviewToken}`));
    emit({ event: "owner_review_required", source_tag: "tool", untrusted: true, reviewToken, runId: info.runId, click: info.click,
      code: info.code, explanation: info.explanation, targetMatched: info.targetMatched,
      beforeSha256: info.beforeSha256, timeoutMs: REVIEW_TIMEOUT_MS });
  });
}

export function minimalBrowserEnv(runtime, source = process.env) {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "PATH", "Path", "COMSPEC", "PATHEXT"]) {
    if (source[key]) env[key] = source[key];
  }
  return { ...env, TEMP: runtime, TMP: runtime, USERPROFILE: runtime,
    LOCALAPPDATA: path.join(runtime, "local"), APPDATA: path.join(runtime, "roaming") };
}
export function requestAllowed(url, method, navigation) {
  try {
    const parsed = new URL(url);
    return method === "GET" && parsed.origin === new URL(LOCAL_PAGE).origin && !parsed.username && !parsed.password &&
      (navigation ? parsed.href === LOCAL_PAGE : parsed.pathname === "/" || parsed.pathname.startsWith("/_next/static/") || parsed.pathname === "/favicon.ico");
  } catch { return false; }
}
export async function openLocalDriver({ headless = true } = {}) {
  const runtime = await reservePrivateDirectory(path.resolve("data/spikes/browser-runs"));
  const cache = path.resolve("data/spikes/browser-cache");
  await mkdir(path.join(runtime.directory, "local")); await mkdir(path.join(runtime.directory, "roaming"));
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  const { firefox } = await import("playwright-core");
  let browser; let context;
  try {
    browser = await firefox.launch({ headless, env: minimalBrowserEnv(runtime.directory), timeout: 20000 });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
      colorScheme: "dark", reducedMotion: "reduce", acceptDownloads: false, permissions: [], serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (!requestAllowed(request.url(), request.method(), request.isNavigationRequest())) await route.abort();
      else await route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    context.on("page", (newPage) => { if (newPage !== page) void newPage.close(); });
    page.on("dialog", (dialog) => { void dialog.dismiss(); });
    page.setDefaultTimeout(5000);
    await page.goto(LOCAL_PAGE, { waitUntil: "networkidle", timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    const inspect = async (point) => {
      if (page.url() !== LOCAL_PAGE) throw new LiveClickError("unexpected_page");
      return page.evaluate((point) => {
        const main = document.querySelector("main"); const details = main?.querySelector("details");
        const summary = details?.querySelector("summary"); const status = details?.querySelector("section[aria-labelledby=status-title]");
        const normalize = (value) => value?.replace(/\s+/g, " ").trim();
        const expected = "Eclipse Crew Your self-hosted AI crew is under construction. View project status Project status The application foundation is being built. Accounts, agents, and tools are not available yet.";
        const safe = document.title === "Eclipse Crew" && document.querySelectorAll("main").length === 1 &&
          main?.querySelectorAll("details").length === 1 &&
          normalize([main.querySelector("h1"), main.querySelector("p"), summary, status?.querySelector("h2"), status?.querySelector("p")].map((element) => element?.textContent).join(" ")) === expected &&
          normalize(summary?.textContent) === "View project status" && normalize(document.body.innerText) === normalize(main.innerText) &&
          main.querySelectorAll("input,textarea,iframe,a").length === 0;
        if (!safe) return { safe: false };
        const box = summary.getBoundingClientRect();
        const hit = point ? document.elementFromPoint(point.x, point.y) : null;
        return { geometry: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, safe: true, open: details.open, statusVisible: !!status?.checkVisibility(), targetBox: { x: box.x, y: box.y, width: box.width, height: box.height },
          hit: !!hit && (hit === summary || summary.contains(hit)),
          fingerprint: JSON.stringify({ html: main.outerHTML, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
            scrollX, scrollY, box: { x: box.x, y: box.y, width: box.width, height: box.height } }) };
      }, point ?? null);
    };
    let clickAttempted = false; let executed = false;
    const capture = async () => {
      const state = await inspect();
      if (!state.safe) throw new LiveClickError("unexpected_page");
      if (state.open) throw new LiveClickError("stale_page");
      const bytes = await page.screenshot({ type: "png", fullPage: false, scale: "css", animations: "disabled", caret: "hide" });
      const after = await inspect();
      if (!after.safe || after.fingerprint !== state.fingerprint) throw new LiveClickError("stale_page");
      const geometry = validateViewportGeometry(bytes, state.geometry);
      validateViewportGeometry(bytes, after.geometry);
      return { bytes, geometry, fingerprint: hash(state.fingerprint), targetBox: state.targetBox };
    };
    const checkTarget = async (click, before) => {
      const state = await inspect(click);
      validateViewportGeometry(before.bytes, state.geometry);
      if (!state.safe) throw new LiveClickError("unexpected_page");
      if (state.open || hash(state.fingerprint) !== before.fingerprint) throw new LiveClickError("stale_page");
      if (!state.hit) throw new LiveClickError("wrong_target");
      const current = await capture();
      if (hash(current.bytes) !== hash(before.bytes)) throw new LiveClickError("stale_page");
      return { targetMatched: true, closedBefore: true };
    };
    await capture();
    return {
      browserName: "firefox",
      capture,
      checkTarget,
      get executed() { return executed; }, get clickAttempted() { return clickAttempted; },
      async execute(click, before) {
        if (clickAttempted) throw new LiveClickError("click_limit");
        await checkTarget(click, before);
        clickAttempted = true;
        await page.mouse.click(click.x, click.y, { button: "left" }); executed = true;
        const after = await inspect();
        if (!after.safe) throw new LiveClickError("unexpected_page");
        const bytes = await page.screenshot({ type: "png", fullPage: false, scale: "css", animations: "disabled", caret: "hide" });
        const verified = await inspect();
        if (!verified.safe || verified.fingerprint !== after.fingerprint) throw new LiveClickError("stale_page");
        const geometry = validateViewportGeometry(bytes, verified.geometry);
        return { closedBefore: true, openAfter: after.open, statusVisible: after.statusVisible, bytes, geometry };
      },
      async close() { await context.close(); await browser.close(); },
    };
  } catch (error) {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {});
    throw error instanceof LiveClickError ? error : new LiveClickError("browser_error");
  }
}

async function main() {
  let driver;
  try {
    let values;
    try { ({ values } = parseArgs({ options: { live: { type: "boolean" }, help: { type: "boolean" } }, strict: true, allowPositionals: false })); }
    catch { throw new LiveClickError("invalid_arguments"); }
    if (values.help) {
      console.log("Usage: npm run spike:meta-live-click -- --live");
      console.log("Fresh Firefox, local placeholder only, one click, at most three 1024-token low-reasoning Contributor requests; no retries. Specific review waits up to five minutes."); return;
    }
    if (!values.live) throw new LiveClickError("live_required");
    try { nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new LiveClickError("configuration_error"); } }); }
    catch { throw new LiveClickError("configuration_error"); }
    if (!process.env.MODEL_API_KEY) throw new LiveClickError("missing_key");
    driver = await openLocalDriver({ headless: false });
    const { summary, runId } = await runLiveClick({ driver, apiKey: process.env.MODEL_API_KEY, live: true, confirmAction: waitForOwnerReview });
    console.log(JSON.stringify({ ...summary, evidence: `data/spikes/task-007-live-click/${runId}/result.json` }));
    if (summary.outcome !== "verified_click") process.exitCode = summary.outcome === "safety_review_required" ? 2 : 1;
  } catch (error) {
    console.error(JSON.stringify({ outcome: error instanceof LiveClickError ? error.code : "browser_error", executed: driver?.executed === true }));
    process.exitCode = 1;
  } finally { await driver?.close().catch(() => {}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
