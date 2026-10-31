import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { normalizeNoVnc } from "../scripts/prepare-novnc.mjs";

const browserPath = path.resolve("node_modules/@novnc/novnc/lib/util/browser.js");
const installed = (await readFile(browserPath, "utf8")).replaceAll("\r\n", "\n");
const original = installed.startsWith("// Eclipse Crew:") ? installed.slice(installed.indexOf('"use strict";'))
  .replace(/\nexport \{[^}]+\};\n$/, "")
  .replace("_interopRequireWildcard(compatLogging)", '_interopRequireWildcard(require("./logging.js"))')
  .replace("_interopRequireDefault(compatBase64)", '_interopRequireDefault(require("../base64.js"))') : installed;
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(original), "ab23e2e197a6bd89af344c33a4939b9da458898b8d7b79f495466d088453f94d", "test must use exact pinned upstream bytes");
const previousWindow = globalThis.window;
let base64Namespace;
try {
  globalThis.window = { console };
  base64Namespace = await import(pathToFileURL(path.resolve("node_modules/@novnc/novnc/lib/base64.js")));
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

function browserContext({ codec = false } = {}) {
  const listeners = new Map();
  const element = () => ({ style: {}, offsetWidth: 100, appendChild(child) { child.offsetWidth = this.offsetWidth - 10; child.parentNode = this; }, removeChild() {} });
  const body = element();
  const window = { devicePixelRatio: 2, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  let releaseProbe, decoded = 0;
  class VideoDecoder {
    static isConfigSupported(config) {
      assert.equal(config.codec, "avc1.42401f");
      return new Promise((resolve) => { releaseProbe = resolve; });
    }
    constructor(callbacks) { this.output = callbacks.output; }
    configure(config) { assert.equal(config.optimizeForLatency, true); }
    decode(chunk) { assert.ok(chunk.data.length > 100); decoded++; this.output({}); }
    async flush() {}
  }
  if (codec) window.VideoDecoder = VideoDecoder;
  const context = vm.createContext({ window, document: { documentElement: {}, body, createElement: element },
    navigator: { platform: "Win32", userAgent: "Mozilla/5.0 Chrome/159.0", maxTouchPoints: 0, msMaxTouchPoints: 0 },
    VideoDecoder, EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } }, Uint8Array });
  return { context, listeners, release: (value) => { assert.equal(typeof releaseProbe, "function"); releaseProbe(value); }, decoded: () => decoded };
}

async function loadBrowser(source, options) {
  assert.equal(typeof vm.SourceTextModule, "function", "run with --experimental-vm-modules");
  const fixture = browserContext(options);
  const browserModule = new vm.SourceTextModule(source, { context: fixture.context, identifier: browserPath });
  await browserModule.link((specifier) => {
    const values = specifier === "./logging.js" ? { __esModule: true, Info() {}, Warn() {}, Error() {}, Debug() {} } : specifier === "../base64.js" ? base64Namespace : null;
    assert.ok(values, "only original two dependency imports are allowed");
    return new vm.SyntheticModule(Object.keys(values), function () { for (const key of Object.keys(values)) this.setExport(key, values[key]); }, { context: fixture.context });
  });
  return { ...fixture, module: browserModule };
}

test("pinned preparation is deterministic, newline-tolerant, idempotent and refuses altered source", () => {
  const normalized = normalizeNoVnc(original);
  assert.equal(normalizeNoVnc(original.replaceAll("\n", "\r\n")), normalized);
  assert.equal(normalizeNoVnc(normalized), normalized);
  assert.equal(normalizeNoVnc(normalized.replace("import compatBase64", "import * as compatBase64")), normalized);
  assert.throws(() => normalizeNoVnc(original + "\n// altered"), /refusing compatibility rewrite/);
  assert.throws(() => normalizeNoVnc(normalized.replace("var dragThreshold", "var alteredThreshold")), /refusing compatibility rewrite/);
  assert.throws(() => normalizeNoVnc(normalized.replace("const exports = {};", "const exports = { altered: true };")), /refusing compatibility rewrite/);
});

test("actual prepared ESM evaluates without CommonJS globals and preserves browser exports and touch updates", async () => {
  const fixture = await loadBrowser(normalizeNoVnc(original));
  await fixture.module.evaluate();
  const exports = fixture.module.namespace;
  assert.equal(exports.dragThreshold, 20);
  assert.equal(exports.isWindows(), true);
  assert.equal(exports.isMac(), false);
  assert.equal(exports.isChrome(), true);
  assert.equal(exports.supportsCursorURIs, true);
  assert.equal(exports.hasScrollbarGutter, true);
  assert.equal(exports.supportsWebCodecsH264Decode, false);
  assert.equal(exports.isTouchDevice, false);
  fixture.listeners.get("touchstart")();
  assert.equal(exports.isTouchDevice, true);
  assert.equal(fixture.listeners.has("touchstart"), false);
  assert.equal(vm.runInContext("typeof require", fixture.context), "undefined");
});

test("prepared module awaits the real WebCodecs probe and retains positive H264/base64 decoding", async () => {
  const fixture = await loadBrowser(normalizeNoVnc(original), { codec: true });
  let completed = false;
  const evaluation = fixture.module.evaluate().then(() => { completed = true; });
  await new Promise(setImmediate);
  assert.equal(completed, false, "top-level probe must remain awaited");
  fixture.release({ supported: true });
  await evaluation;
  assert.equal(fixture.module.namespace.supportsWebCodecsH264Decode, true);
  assert.equal(fixture.decoded(), 1);
});

test("an unsupported awaited WebCodecs probe remains false without attempting decode", async () => {
  const fixture = await loadBrowser(normalizeNoVnc(original), { codec: true });
  const evaluation = fixture.module.evaluate();
  await new Promise(setImmediate);
  fixture.release({ supported: false });
  await evaluation;
  assert.equal(fixture.module.namespace.supportsWebCodecsH264Decode, false);
  assert.equal(fixture.decoded(), 0);
});

test("CLI refuses unpinned versions and tampered bytes, while repeated exact preparation is safe", async () => {
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, "eclipse-novnc-compat-"));
  const scriptDir = path.join(directory, "scripts");
  const packageDir = path.join(directory, "node_modules", "@novnc", "novnc");
  const fixtureBrowser = path.join(packageDir, "lib", "util", "browser.js");
  try {
    await mkdir(scriptDir, { recursive: true }); await mkdir(path.dirname(fixtureBrowser), { recursive: true });
    await writeFile(path.join(scriptDir, "prepare-novnc.mjs"), await readFile("scripts/prepare-novnc.mjs"));
    const run = () => spawnSync(process.execPath, [path.join(scriptDir, "prepare-novnc.mjs")], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const metadata = (version) => writeFile(path.join(packageDir, "package.json"), JSON.stringify({ version }));
    await metadata("1.6.0"); await writeFile(fixtureBrowser, original);
    assert.equal(run().status, 0); const first = await readFile(fixtureBrowser, "utf8");
    assert.equal(first, normalizeNoVnc(original)); assert.equal(run().status, 0); assert.equal(await readFile(fixtureBrowser, "utf8"), first);
    await metadata("1.6.1"); const rejectedVersion = run();
    assert.equal(rejectedVersion.status, 1); assert.match(rejectedVersion.stderr, /compatibility preparation failed/); assert.equal(await readFile(fixtureBrowser, "utf8"), first);
    await metadata("1.6.0"); await writeFile(fixtureBrowser, original + "\n// changed");
    const rejectedSource = run(); assert.equal(rejectedSource.status, 1); assert.equal(await readFile(fixtureBrowser, "utf8"), original + "\n// changed");
  } finally {
    const resolved = await realpath(directory); assert.equal(path.dirname(resolved), tempRoot); assert.ok(path.basename(resolved).startsWith("eclipse-novnc-compat-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
