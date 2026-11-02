import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startMockVendor } from "../docker/desktop/mock-vendor/server.mjs";
import { INVOICES, invoicePdf } from "../docker/desktop/mock-vendor/fixtures.mjs";
import { sameFixtureProcess } from "../docker/desktop/mock-vendor/control.mjs";

async function fixture(t) { const site = await startMockVendor(); t.after(() => site.close()); return site; }
const csrf = (html) => /name="csrf-token" content="([a-f0-9]{64})"/.exec(html)[1];
const control = (site, token, body, headers = {}) => fetch(`${site.origin}/__demo/control`, { method: "POST",
  headers: { "Content-Type": "application/json", Origin: site.origin, "X-Demo-CSRF": token, ...headers }, body: JSON.stringify(body) });

test("layout switch preserves invoices and PDFs, removes A targets and reset restores October", async (t) => {
  const site = await fixture(t);
  const html = await (await fetch(site.url)).text();
  assert.match(html, /data-layout="a"/); assert.match(html, /Download PDF/);
  assert.match(html, /DEMO-1002/); assert.match(html, /DEMO-1003/); assert.doesNotMatch(html, /DEMO-1001/);
  const before = Buffer.from(await (await fetch(`${site.origin}/invoices/DEMO-1002.pdf`)).arrayBuffer());
  const response = await control(site, csrf(html), { action: "layout", layout: "b", month: "all" });
  assert.equal(response.status, 200);
  const next = await response.json();
  const b = await (await fetch(site.origin + next.path)).text();
  assert.match(b, /data-layout="b"/); assert.match(b, /Billing documents/); assert.match(b, /Get invoice/);
  assert.doesNotMatch(b, /Download PDF|<table/); for (const invoice of INVOICES) assert.ok(b.includes(invoice.id));
  assert.match(b, /Invoice data is unchanged/);
  const after = Buffer.from(await (await fetch(`${site.origin}/invoices/DEMO-1002.pdf`)).arrayBuffer());
  assert.deepEqual(before, after);
  const reset = await control(site, csrf(b), { action: "reset" });
  const restored = await (await fetch(site.origin + (await reset.json()).path)).text();
  assert.match(restored, /data-layout="a"/); assert.match(restored, /Demo reset/); assert.doesNotMatch(restored, /DEMO-1001/);
});

test("filters, empty state, local assets and safe document-not-found page", async (t) => {
  const site = await fixture(t);
  const empty = await (await fetch(`${site.origin}/?month=2026-12`)).text();
  assert.match(empty, /No invoices for this month/); assert.match(empty, /Clear filters/);
  const all = await (await fetch(`${site.origin}/?month=all`)).text();
  for (const invoice of INVOICES) assert.ok(all.includes(invoice.id));
  for (const asset of ["/client.js", "/portal.css"]) assert.equal((await fetch(site.origin + asset)).status, 200);
  const missing = await fetch(`${site.origin}/invoices/DEMO-9999.pdf`);
  assert.equal(missing.status, 404); assert.match(await missing.text(), /Return to invoices/);
  assert.equal((await fetch(site.origin + "/.env")).status, 404);
  assert.doesNotMatch(all, /(?:src|href)="https?:\/\/|__DEMO_CSRF__|__DEMO_NOTICE__/);
});

test("strict query, method, Origin, CSRF, content type and body limits deny without mutation", async (t) => {
  const site = await fixture(t); const token = csrf(await (await fetch(site.url)).text());
  for (const query of ["?month=2026-01", "?month=all&month=2026-10", "?extra=1", "?notice=arbitrary"])
    assert.equal((await fetch(site.url + query)).status, 400, query);
  const value = { action: "layout", layout: "b", month: "2026-10" };
  assert.equal((await control(site, "0".repeat(64), value)).status, 403);
  assert.equal((await control(site, token, value, { Origin: "http://evil.test" })).status, 403);
  assert.equal((await control(site, token, { ...value, extra: true })).status, 400);
  assert.equal((await control(site, token, { ...value, layout: "other" })).status, 400);
  for (const body of ['{"action":"reset","action":"reset"}', '{"action":"reset","act\\u0069on":"reset"}']) {
    const duplicate = await fetch(`${site.origin}/__demo/control`, { method: "POST", headers: {
      "Content-Type": "application/json", Origin: site.origin, "X-Demo-CSRF": token,
    }, body });
    assert.equal(duplicate.status, 400);
  }
  assert.equal((await control(site, token, value, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await control(site, token, { blob: "x".repeat(2048) })).status, 413);
  assert.equal((await fetch(site.origin + "/__demo/control")).status, 404);
  assert.equal((await fetch(site.url, { method: "DELETE" })).status, 405);
  assert.match(await (await fetch(site.url)).text(), /data-layout="a"/);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(site.url, { headers: { Host: "evil.test" } }, (response) => { response.resume(); resolve(response.statusCode); }); request.on("error", reject);
  }); assert.equal(wrongHost, 403);
  const response = await fetch(site.url);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.doesNotMatch(response.headers.get("content-security-policy"), /unsafe-inline|unsafe-eval/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("PDFs have correct text, canonical xref byte offsets and fixed attachment names", async (t) => {
  const site = await fixture(t);
  for (const invoice of INVOICES) {
    const response = await fetch(`${site.origin}/invoices/${invoice.id}.pdf`);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${invoice.id}.pdf"`);
    const pdf = Buffer.from(await response.arrayBuffer()); assert.deepEqual(pdf, invoicePdf(invoice));
    const text = pdf.toString("ascii"); assert.match(text, /^%PDF-1.4/); assert.ok(text.includes(invoice.id) && text.includes(invoice.date));
    assert.ok(text.includes((invoice.cents / 100).toFixed(2))); assert.ok(text.includes("SYNTHETIC INVOICE"));
    const xref = Number(/startxref\n(\d+)/.exec(text)[1]); assert.equal(text.slice(xref, xref + 4), "xref");
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n /gm)].map((match) => Number(match[1]));
    offsets.forEach((offset, index) => assert.equal(text.slice(offset, offset + 7), `${index + 1} 0 obj`));
  }
});

test("lifecycle signaling refuses peer UID, recycled PID, wrong executable and extra args", () => {
  const state = { pid: 41, uid: 20000, birth: "1234" };
  const identity = { ...state, zombie: false, cmdline: ["/usr/local/bin/node", "/fixture/control.mjs", "serve"] };
  assert.equal(sameFixtureProcess(state, identity, "/fixture/control.mjs"), true);
  for (const patch of [{ uid: 20001 }, { birth: "1235" }, { pid: 42 }, { zombie: true },
    { cmdline: ["/usr/local/bin/node", "/unrelated.mjs", "serve"] }, { cmdline: [...identity.cmdline, "other"] }])
    assert.ok(!sameFixtureProcess(state, { ...identity, ...patch }, "/fixture/control.mjs"));
  assert.ok(!sameFixtureProcess(state, null));
});
