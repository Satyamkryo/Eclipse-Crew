import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

import { SCREEN, collectControls, finalize, verifySnapshot } from "../docker/desktop/page-snapshot.mjs";

// TASK-084. The real-browser fixture pass (open shadow roots, iframes, payment and sensitive frames, click accuracy
// and p95 on heavy.html) needs the desktop image, Chromium and xdotool. It is run from inside the image the same way
// scripts/spikes/shadow-frame/probe.mjs runs: `npm run test:page-snapshot` there, with ECLIPSE_PAGE_SNAPSHOT=1.
const IN_DESKTOP = process.env.ECLIPSE_PAGE_SNAPSHOT === "1" && existsSync("/opt/chrome-for-testing/chrome-linux64/chrome") && Boolean(process.env.DISPLAY);

test("finalize maps a top-frame control to screen coordinates and marks open shadow roots", () => {
  const info = { kind: "top", offset: { x: 0, y: 0 }, visibleBox: { x: 0, y: 0, width: SCREEN.width, height: SCREEN.height } };
  const [control] = finalize([{ role: "button", name: "Save", tag: "button", x: 10, y: 20, width: 50, height: 30, shadow: "open", focused: true }],
    info, { x: 0, y: 0 });
  assert.deepEqual(control, { role: "button", name: "Save", tag: "button", x: 10, y: 20, width: 50, height: 30, frame: "top", shadow: true,
    focused: true, centreX: 35, centreY: 35, topCentreX: 35, topCentreY: 35, centreOffscreen: false });
});

test("a child-frame control is offset and clipped to the frame's visible box and the screen", () => {
  const info = { kind: "cross-site", offset: { x: 100, y: 50 }, visibleBox: { x: 100, y: 50, width: 200, height: 100 } };
  const [control] = finalize([{ role: "textbox", name: "Email", tag: "input", x: 150, y: 60, width: 200, height: 100, shadow: "none", focused: false }],
    info, { x: 0, y: 0 });
  assert.deepEqual([control.x, control.y, control.width, control.height, control.frame, control.shadow],
    [250, 110, 50, 40, "child", false]);
  assert.deepEqual([control.centreX, control.centreY], [275, 130]);
  const hidden = finalize([{ role: "button", name: "Offscreen", tag: "button", x: 0, y: 200, width: 20, height: 20, shadow: "none", focused: false }],
    info, { x: 0, y: 0 });
  assert.deepEqual(hidden, [], "a control below the frame's visible part is not listed");
});

test("verifySnapshot reads the merged inventory of frame and shadow controls", () => {
  const snapshot = { url: "https://a.example/settings", elements: [
    { name: "Save" }, { name: "Country", frame: "child", shadow: false }, { name: "Pay now", frame: "top", shadow: true },
  ] };
  assert.equal(verifySnapshot(snapshot, { kind: "control_present", value: "Country" }).status, "pass");
  assert.equal(verifySnapshot(snapshot, { kind: "control_present", value: "Pay now" }).status, "pass");
  assert.equal(verifySnapshot(snapshot, { kind: "control_absent", value: "Delete" }).status, "pass");
  assert.equal(verifySnapshot(snapshot, { kind: "control_present", value: "Delete" }).status, "fail");
  assert.equal(verifySnapshot(snapshot, { kind: "url_path", value: "/settings" }).status, "pass");
});

test("real-browser fixture pass (desktop image and Chromium)", { skip: !IN_DESKTOP && "needs the desktop image with ECLIPSE_PAGE_SNAPSHOT=1 and Chromium" }, async () => {
  const fixtureDir = new URL("../scripts/spikes/shadow-frame/fixtures/", import.meta.url);
  const fixtureNames = ["open-shadow.html", "frames.html", "cross-site.html", "sensitive.html", "payment.html", "obstruction.html", "heavy.html",
    "_frame-inside.html", "_frame-cross.html", "_frame-deep-outer.html", "_frame-deep-inner.html", "_frame-half.html", "_frame-scrolled.html",
    "_frame-otp.html", "_frame-portal.html", "_frame-payment.html", "_frame-covered.html"];
  const fixtures = new Map(fixtureNames.map((name) => [name, readFileSync(new URL(name, fixtureDir), "utf8")]));
  const server = (host) => createServer((request, response) => {
    const name = path.basename(new URL(request.url, `http://${host}`).pathname);
    const content = fixtures.get(name);
    response.writeHead(content ? 200 : 404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(content ?? "not found");
  });
  const servers = [server("127.0.0.1"), server("localhost")];
  let browser;
  try {
    await Promise.all([new Promise((resolve) => servers[0].listen(8081, "127.0.0.1", resolve)),
      new Promise((resolve) => servers[1].listen(8082, "localhost", resolve))]);
    browser = await chromium.launch({ executablePath: "/opt/chrome-for-testing/chrome-linux64/chrome", headless: false,
      args: ["--disable-dev-shm-usage", "--window-position=0,0", "--window-size=1024,768"] });
    const page = await browser.newPage({ viewport: { width: SCREEN.width, height: SCREEN.height } });

    // Each expected result is declared before any scanner result is asserted.
    const expectations = [
      { fixture: "open-shadow.html", listed: ["Configure", "Add to cart"], absent: [] },
      { fixture: "frames.html", listed: ["Top page button", "Inside frame", "Deep frame"], absent: ["Scrolled out"] },
      { fixture: "cross-site.html", listed: ["Host page button", "Cross-site button", "Cross-site shadow"], absent: [] },
      { fixture: "sensitive.html", listed: ["Shadow sign in"], absent: ["Account password", "Verification code", "Portal password"] },
      { fixture: "payment.html", listed: ["Pay later"], absent: ["Card number", "Expiry date", "Security code", "Payment frame button"] },
      { fixture: "obstruction.html", listed: ["Frame clear", "Remove target"], absent: ["Covered shadow", "Covered frame"] },
      { fixture: "heavy.html", listed: ["Heavy first shadow"], absent: [] },
    ];
    for (const expected of expectations) {
      await page.goto(`http://127.0.0.1:8081/${expected.fixture}`, { waitUntil: "load" });
      const { controls } = await collectControls({ page, origin: { x: 0, y: 0 } });
      const names = controls.map((control) => control.name);
      for (const name of expected.listed) assert.ok(names.includes(name), `${expected.fixture}: expected production scanner to list ${name}`);
      for (const name of expected.absent) assert.ok(!names.includes(name), `${expected.fixture}: expected production scanner to omit ${name}`);
    }
  } finally {
    await browser?.close();
    await Promise.all(servers.map((item) => new Promise((resolve) => item.close(resolve))));
  }
});
