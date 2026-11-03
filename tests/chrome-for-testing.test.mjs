import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadBrowser, loadBrowserLock, validateBrowserEntry, validateBrowserLock } from "../docker/desktop/browser-build.mjs";

test("browser lock pins one measured Chrome for Testing archive per CPU", async () => {
  const lock = await loadBrowserLock();
  assert.equal(lock.browsers.amd64.version, "156.0.8078.80");
  assert.equal(lock.browsers.amd64.bytes, 201329937);
  assert.equal(lock.browsers.amd64.sha256, "b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7");
  assert.equal(lock.browsers.amd64.url, "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux64/chrome-linux64.zip");
  assert.equal(lock.browsers.arm64.version, "156.0.8078.80");
  assert.equal(lock.browsers.arm64.bytes, 200722708);
  assert.equal(lock.browsers.arm64.sha256, "1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724");
  assert.equal(lock.browsers.arm64.url, "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux-arm64/chrome-linux-arm64.zip");
  for (const mutate of [
    (value) => { value.schema = 2; }, (value) => { value.browsers.amd64.sha256 = "bad"; },
    (value) => { value.browsers.amd64.url = "https://example.com/chrome.zip"; },
    (value) => { value.browsers.amd64.url = "http://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux64/chrome-linux64.zip"; },
    (value) => { value.browsers.amd64.version = "156.0.8078.4"; },
    (value) => { value.browsers.arm64.url = "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux64/chrome-linux64.zip"; },
    (value) => { value.browsers.arm64 = null; },
    (value) => { delete value.browsers.arm64; },
  ]) { const copy = structuredClone(lock); mutate(copy); assert.throws(() => validateBrowserLock(copy)); }
  for (const entry of [{ ...lock.browsers.amd64, bytes: 0 }, { ...lock.browsers.amd64, sha256: "x" }, { ...lock.browsers.amd64, url: "https://example.com/x.zip" }])
    assert.throws(() => validateBrowserEntry(entry));
});

test("browser downloader verifies exact bytes and refuses corruption, size mismatch and errors", async () => {
  const root = await realpath(tmpdir()); const directory = await mkdtemp(path.join(root, "eclipse078-browser-"));
  const bytes = Buffer.from("synthetic chrome archive");
  const entry = { version: "156.0.8078.80", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux64/chrome-linux64.zip" };
  try {
    for (const response of [new Response("no", { status: 503 }), new Response(bytes, { headers: { "content-length": "1" } }),
      new Response(Buffer.alloc(bytes.length)), new Response(Buffer.alloc(bytes.length + 1))]) {
      await assert.rejects(() => downloadBrowser(entry, path.join(directory, "chrome.zip"), { fetchImpl: async () => response }));
      assert.deepEqual(await readdir(directory), []);
    }
    await assert.rejects(() => downloadBrowser(entry, path.join(directory, "chrome.zip"), { fetchImpl: async () => { throw Error("redirect refused"); } }));
    const result = await downloadBrowser(entry, path.join(directory, "chrome.zip"), { fetchImpl: async () => new Response(bytes) });
    assert.equal(result.bytes, bytes.length);
    assert.deepEqual(await readFile(path.join(directory, "chrome.zip")), bytes);
  } finally {
    const resolved = await realpath(directory); assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith("eclipse078-browser-")); await rm(resolved, { recursive: true, force: true });
  }
});

test("the image and tests use the measured artifact, not a moving Chromium channel", async () => {
  const dockerfile = await readFile("docker/desktop/Dockerfile", "utf8");
  assert.match(dockerfile, /COPY browser-build\.lock\.json browser-build\.mjs/);
  assert.match(dockerfile, /node browser-build\.mjs fetch/);
  assert.match(dockerfile, /unzip -q \/tmp\/chrome\.zip -d \/tmp\/chrome-extract/);
  assert.match(dockerfile, /mv "\/tmp\/chrome-extract\/\$directory" \/opt\/chrome-for-testing\/chrome-linux64/);
  assert.doesNotMatch(dockerfile, /chromium-browser-snapshots|storage\.googleapis\.com\/chromium/);
  for (const file of ["docker/desktop/check-tools.mjs", "docker/desktop/session-worker.mjs", "docker/desktop/agent-store.mjs", "docker/desktop/desktop-config/browser-focus.sh"]) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /\/opt\/chromium\/chrome-linux\/chrome/, file);
  }
  const checkTools = await readFile("docker/desktop/check-tools.mjs", "utf8");
  assert.match(checkTools, /BROWSER_EXECUTABLE/); assert.match(checkTools, /BROWSER_VERSION/);
  const worker = await readFile("docker/desktop/session-worker.mjs", "utf8");
  assert.match(worker, /BROWSER_EXECUTABLE/); assert.match(worker, /BROWSER_PROFILE/);
  const store = await readFile("docker/desktop/agent-store.mjs", "utf8");
  assert.match(store, /\.config\/chrome-for-testing/);
});

test("no compose file or script publishes or pushes the desktop image", async () => {
  const files = ["docker-compose.yml", "docker-compose.override.yml"].filter(Boolean);
  for (const file of files) {
    let text = ""; try { text = await readFile(file, "utf8"); } catch { continue; }
    assert.doesNotMatch(text, /docker\s+push/);
    const desktop = /^\s{2}desktop:\s*$([\s\S]*?)(?=^\s{2}[a-z-]+:\s*$|$)/m.exec(text)?.[1] ?? "";
    assert.doesNotMatch(desktop, /^\s+image:/m);
  }
  const scripts = ["scripts/desktop-agent.mjs", "scripts/spikes/chrome-for-testing/run.mjs"];
  for (const file of scripts) { const text = await readFile(file, "utf8"); assert.doesNotMatch(text, /docker\s+push/); }
});
