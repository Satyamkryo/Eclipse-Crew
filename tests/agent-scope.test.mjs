import assert from "node:assert/strict";
import test from "node:test";

import { checkTyped, deriveScope, extractTargets, hostFromUrl, hostInScope, normalizeHost } from "../lib/agent/scope.ts";

const scope = (task = "Open example.com.", allowedHosts = [], startHref = null) =>
  deriveScope({ task, allowedHosts, startHref });

test("scope hosts cover the owner's task, the agent allowlist and the start page", () => {
  const derived = scope("Open example.com and login.", ["vendor.test"], "https://start.test/page");
  assert.deepEqual(new Set(derived.hosts), new Set(["example.com", "vendor.test", "start.test"]));
  assert.equal(hostInScope("example.com", derived), true);
  assert.equal(hostInScope("app.example.com", derived), true);
  assert.equal(hostInScope("badexample.com", derived), false);
  assert.equal(hostInScope("example.com.evil.test", derived), false);
  assert.equal(hostInScope("start.test", derived), true);
});

test("host matching normalises case, trailing dots, ports and www", () => {
  const derived = { hosts: ["example.com"], emails: [] };
  for (const host of ["EXAMPLE.COM", "example.com.", "example.com:8443", "www.example.com", "deep.app.example.com"]) {
    assert.equal(hostInScope(host, derived), true, host);
  }
  assert.equal(normalizeHost(" Example.COM. "), "example.com");
  assert.equal(hostFromUrl("https://vendor.example.com@evil.test/"), "evil.test");
  assert.equal(hostFromUrl("about:blank"), null);
});

test("IP literals match exactly, never as a suffix", () => {
  const derived = { hosts: ["127.0.0.1", "::1"], emails: [] };
  assert.equal(hostInScope("127.0.0.1", derived), true);
  assert.equal(hostInScope("127.0.0.10", derived), false);
  assert.equal(hostInScope("::1", derived), true);
  assert.equal(hostInScope("localhost", derived), false);
});

test("file names are not hosts; URLs, www names, IPv4 and short-list TLDs are", () => {
  const targets = extractTargets("Open example.com, see www.vendor.test, 127.0.0.1, report.pdf, main.py, readme.md, and https://shop.example.io/cart.");
  assert.deepEqual(new Set(targets.hosts), new Set(["example.com", "www.vendor.test", "127.0.0.1", "shop.example.io"]));
  assert.equal(targets.hosts.includes("report.pdf"), false);
  assert.equal(targets.hosts.includes("main.py"), false);
  assert.equal(targets.hosts.includes("readme.md"), false);
});

test("typed hosts must be in scope; look-alikes, userinfo tricks and bad URLs fail closed", () => {
  const derived = scope("Open example.com.");
  assert.deepEqual(checkTyped("Open example.com", derived, "https://example.com/"), { ok: true });
  assert.deepEqual(checkTyped("Open https://app.example.com/cart", derived, "https://example.com/"), { ok: true });
  assert.deepEqual(checkTyped("Open https://badexample.com", derived, null), { ok: false, rule: "host" });
  assert.deepEqual(checkTyped("Open https://example.com.evil.test", derived, null), { ok: false, rule: "host" });
  assert.deepEqual(checkTyped("Open https://vendor.example.com@evil.test", derived, null), { ok: false, rule: "host" });
  assert.deepEqual(checkTyped("Open https://[", derived, null), { ok: false, rule: "host" });
  assert.deepEqual(checkTyped("Open https://xn--bcher-kva.example", derived, null), { ok: false, rule: "host" });
  assert.deepEqual(checkTyped("Open localhost:3000", derived, null), { ok: false, rule: "host" });
  assert.deepEqual(checkTyped("Open localhost", scope("Open localhost."), null), { ok: true });
});

test("emails must be named by the owner; email domains are not destinations", () => {
  const derived = scope("Send the report to owner@example.com.");
  assert.deepEqual(checkTyped("owner@example.com", derived, null), { ok: true });
  assert.deepEqual(checkTyped("OWNER@example.com", derived, null), { ok: true });
  assert.deepEqual(checkTyped("attacker@evil.test", derived, null), { ok: false, rule: "recipient" });
  assert.deepEqual(checkTyped("attacker@evil.com", derived, null), { ok: false, rule: "recipient" }, "the email domain is not treated as a site");
  assert.deepEqual(checkTyped("owner @ example.com", derived, null), { ok: false, rule: "host" }, "a split email is not a recipient, and its domain is not a site");
  assert.equal(extractTargets("owner @ example.com").emails.length, 0);
});

test("an out-of-scope page refuses typing unless the whole text is one allowed address", () => {
  const derived = scope("Open example.com.", [], "https://example.com/");
  assert.deepEqual(checkTyped("hello", derived, "https://evil.test/"), { ok: false, rule: "page" });
  assert.deepEqual(checkTyped("https://example.com/back", derived, "https://evil.test/"), { ok: true });
  assert.deepEqual(checkTyped("hello", derived, "about:blank"), { ok: true });
  assert.deepEqual(checkTyped("hello", derived, null), { ok: true });
});

test("hostile input is bounded and never throws", () => {
  const derived = scope("Open example.com.");
  const long = `${"a ".repeat(5_000)}https://evil.test`;
  assert.deepEqual(checkTyped(long, derived, null), { ok: true }, "text beyond the 2000 character bound is not examined");
  assert.deepEqual(checkTyped("bad\u0000\u001fhost https://evil.test", derived, null), { ok: false, rule: "host" });
  assert.deepEqual(checkTyped("x".repeat(100_000), derived, null), { ok: true });
  assert.deepEqual(checkTyped(42, derived, null), { ok: true });
});

test("TASK-083 earlier owner text extends scope; agent replies never do", () => {
  const base = deriveScope({ task: "Open the page." });
  const owner = deriveScope({ task: "Open the page.", extraOwnerTexts: ["mail priya@example.com at shop.example.org"] });
  assert.equal(hostInScope("shop.example.org", owner), true);
  assert.ok(owner.emails.includes("priya@example.com"));
  assert.equal(hostInScope("shop.example.org", base), false);
  assert.deepEqual(base.emails, []);
});

test("an any-public-web agent may type any public domain but never IPs, internal names or unnamed emails", () => {
  const scope = deriveScope({ task: "go on google search for top 5 geopolitical news", anyPublicWeb: true });
  assert.equal(checkTyped("google.com", scope, "about:blank").ok, true);
  assert.equal(checkTyped("https://news.google.com/topics", scope, "https://www.google.com/").ok, true);
  assert.equal(hostInScope("10.0.0.5", scope), false);
  assert.equal(hostInScope("printer.local", scope), false);
  assert.equal(hostInScope("localhost", scope), false);
  assert.equal(checkTyped("mail stranger@example.com", scope, "https://www.google.com/").ok, false);
  const strict = deriveScope({ task: "go on google search for top 5 geopolitical news" });
  assert.equal(checkTyped("google.com", strict, "about:blank").ok, false);
});
