import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { SCANNERS, classify, cleanupTarget, containerArgs, containerName, recommendation, renderMarkdown, runLabel } from "../scripts/spikes/shadow-frame/run.mjs";

const RUN = "0123456789ab";
const SECCOMP = path.resolve("docker/desktop/seccomp_profile.json");
const REQUIRED = ["run", "-d", "--name", containerName(RUN), "--label", runLabel(RUN), "--init", "--user", "65534:65534", "--read-only",
  "--cap-drop=ALL", "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${SECCOMP}`, "--shm-size", "128m",
  "--tmpfs", "/tmp:rw,nosuid,size=536870912,mode=1777", "--network", "none", "main-desktop:latest", "sleep", "infinity"];
// Flags that would widen what the spike container can reach. --security-opt is required, but only in its two pinned forms.
const FORBIDDEN = ["-v", "--volume", "--mount", "-p", "--publish", "--publish-all", "-P", "--privileged", "--cap-add", "--env-file", "-e",
  "--env", "--device", "--network=host", "--pid=host", "--ipc=host", "apparmor=unconfined", "--entrypoint", "-w", "--workdir", "--group-add"];

test("containerArgs carries every hardening flag the prompt fixes and none of the forbidden ones", () => {
  const args = containerArgs(RUN, SECCOMP, false);
  assert.deepEqual(args, REQUIRED);
  for (const flag of FORBIDDEN) {
    assert.ok(!args.includes(flag), `forbidden flag ${flag}`);
    assert.ok(!args.some((arg) => arg.startsWith(`${flag}=`)), `forbidden flag ${flag}=`);
  }
  assert.equal(args.filter((arg) => arg === "--security-opt").length, 2);
  assert.ok(args.includes("no-new-privileges:true"));
  assert.ok(args.includes(`seccomp=${SECCOMP}`));
  assert.throws(() => containerArgs(RUN, "docker/desktop/seccomp_profile.json", false), (error) => error.code === "seccomp_path_absolute");
  assert.throws(() => containerArgs("Z".repeat(12), SECCOMP, false), (error) => error.code === "invalid_run");
});

test("--live changes only the network value", () => {
  const offline = containerArgs(RUN, SECCOMP, false);
  const online = containerArgs(RUN, SECCOMP, true);
  assert.equal(online.length, offline.length);
  assert.equal(online.join("\n").replace("bridge", "none"), offline.join("\n"));
  assert.equal(online[online.indexOf("--network") + 1], "bridge");
  assert.equal(offline[offline.indexOf("--network") + 1], "none");
});

const scan = (names, extra = {}) => ({
  found: names.map((name) => ({ name, role: "button", frame: "top", shadow: "none", x: 10, y: 10, width: 40, height: 20, centreX: 30, centreY: 20 })),
  frames: 1, paymentFrames: 0, truncated: false, counts: {}, ...extra,
});
const emptyClicks = () => ({ expected: 0, landed: 0, results: [] });
function fixtureCell(name, names, p95 = 200, outcome = "complete") {
  const entry = { fixture: name, outcome, url: `http://127.0.0.1:8081/${name}`, scans: {}, timings: {}, clicks: {}, verify: {}, errors: [] };
  for (const scanner of SCANNERS) {
    entry.scans[scanner] = scan(names);
    entry.timings[scanner] = { samples: [p95, p95], median: p95, p95 };
    entry.clicks[scanner] = { expected: names.length, landed: names.length, results: names.map((item) => ({ name: item, ok: true })) };
  }
  return entry;
}
const cases = [
  { fixture: "a.html", name: "Alpha", role: "button", frame: "top", shadow: "none", expect: "listed" },
  { fixture: "a.html", name: "Beta", role: "button", frame: "top", shadow: "none", expect: "listed" },
  { fixture: "a.html", name: "Secret", role: "textbox", frame: "top", shadow: "none", expect: "sensitive" },
  { fixture: "b.html", name: "Gamma", role: "button", frame: "top", shadow: "open", expect: "listed" },
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const perfect = () => ({ fixtures: [fixtureCell("a.html", ["Alpha", "Beta"]), fixtureCell("b.html", ["Gamma"])] });

test("classify marks pass only when every piece of data is present and nothing forbidden is listed", () => {
  const classified = classify(perfect(), cases);
  assert.equal(classified.fixtures[0].scanners.A.status, "pass");
  assert.equal(classified.fixtures[1].scanners.B.status, "pass");
  assert.equal(classified.perScanner.A.pass, 2);
  assert.equal(classified.safety.A.status, "pass");
  assert.equal(classified.speed.A.status, "blocked"); // no heavy.html in this fixture set

  const missedClick = clone(perfect());
  missedClick.fixtures[0].clicks.A.results[1].ok = false;
  assert.equal(classify(missedClick, cases).fixtures[0].scanners.A.status, "partial");

  const clicksNotAttempted = clone(perfect());
  clicksNotAttempted.fixtures[0].clicks.A = { expected: 1, landed: 1, results: [{ name: "Alpha", ok: true }] };
  assert.notEqual(classify(clicksNotAttempted, cases).fixtures[0].scanners.A.status, "pass");

  const missingTarget = clone(perfect());
  missingTarget.fixtures[0].scans.A.found = missingTarget.fixtures[0].scans.A.found.filter((item) => item.name !== "Beta");
  assert.equal(classify(missingTarget, cases).fixtures[0].scanners.A.status, "partial");

  const leaked = clone(perfect());
  leaked.fixtures[0].scans.A.found.push(scan(["Secret"]).found[0]);
  leaked.fixtures[0].clicks.A.expected = 3;
  const leakResult = classify(leaked, cases);
  assert.notEqual(leakResult.fixtures[0].scanners.A.status, "pass");
  assert.equal(leakResult.safety.A.status, "fail");
  assert.equal(leakResult.safety.B.status, "pass");

  const scannerRanNoData = clone(perfect());
  delete scannerRanNoData.fixtures[1].scans.B;
  assert.equal(classify(scannerRanNoData, cases).fixtures[1].scanners.B.status, "blocked");

  const fixtureBlocked = clone(perfect());
  fixtureBlocked.fixtures[0].outcome = "blocked";
  fixtureBlocked.fixtures[0].reason = "probe_error";
  assert.notEqual(classify(fixtureBlocked, cases).fixtures[0].scanners.A.status, "pass");

  const empty = classify({ fixtures: [] }, cases);
  assert.ok(empty.fixtures.every((cell) => SCANNERS.every((scanner) => cell.scanners[scanner].status !== "pass")));
  assert.equal(empty.perScanner.A.listedFound, 0);
});

test("speed passes at 1500 ms on heavy.html and a target nobody finds is unsolved", () => {
  const heavyCases = [...cases, { fixture: "heavy.html", name: "Heavy", role: "button", frame: "top", shadow: "open", expect: "listed" }];
  const withHeavy = (p95) => ({ fixtures: [...perfect().fixtures, fixtureCell("heavy.html", ["Heavy"], p95)] });
  assert.equal(classify(withHeavy(1500), heavyCases).speed.A.status, "pass");
  assert.equal(classify(withHeavy(1501), heavyCases).speed.A.status, "fail");
  assert.equal(classify(withHeavy(null), heavyCases).speed.A.status, "blocked");

  const noneFound = clone(perfect());
  noneFound.fixtures[1].scans = { current: scan([]), A: scan([]), B: scan([]) };
  noneFound.fixtures[1].clicks = { current: emptyClicks(), A: emptyClicks(), B: emptyClicks() };
  const result = classify(noneFound, [{ fixture: "b.html", name: "Gamma", role: "button", frame: "top", shadow: "closed", expect: "listed" }]);
  assert.deepEqual(result.unsolved, [{ fixture: "b.html", name: "Gamma", role: "button", frame: "top", shadow: "closed" }]);
  assert.equal(result.fixtures[0].scanners.A.status, "fail");
  assert.equal(recommendation(result).choice.startsWith("don't build"), true);
});

test("cleanup refuses any container this run did not start", () => {
  const own = { Name: `/${containerName(RUN)}`, Id: "sha256:own", Config: { Labels: { "ai.eclipse.spike": `shadow-frame-${RUN}` } } };
  assert.equal(cleanupTarget([own], RUN), "sha256:own");
  // A Compose-built image carries its project labels into every container, including this one. That alone
  // must not block cleanup, or the spike can never remove what it started.
  assert.equal(cleanupTarget([{ ...own, Config: { Labels: { ...own.Config.Labels, "com.docker.compose.project": "main",
    "com.docker.compose.service": "desktop", "com.docker.compose.version": "5.6.1" } } }], RUN), "sha256:own");
  const mutations = [
    { Name: "/eclipse-spike-sf-000000000000" },
    { Config: { Labels: { "ai.eclipse.spike": "shadow-frame-000000000000" } } },
    { Config: { Labels: { "ai.eclipse.spike": `shadow-frame-${RUN}`, "com.docker.compose.container-number": "1" } } },
    { Config: { Labels: { "ai.eclipse.spike": `shadow-frame-${RUN}`, "com.docker.compose.config-hash": "abcd" } } },
    { Config: { Labels: {} } },
    { Id: "" },
  ];
  for (const mutation of mutations) {
    const candidate = [{ ...own, ...mutation, Config: { ...own.Config, ...(mutation.Config ?? {}) } }];
    assert.throws(() => cleanupTarget(candidate, RUN), (error) => error.code === "cleanup_refused", JSON.stringify(mutation));
  }
  assert.throws(() => cleanupTarget([], RUN), (error) => error.code === "cleanup_ambiguous");
  assert.throws(() => cleanupTarget([own, own], RUN), (error) => error.code === "cleanup_ambiguous");
  assert.throws(() => cleanupTarget(null, RUN), (error) => error.code === "cleanup_ambiguous");
});

test("the markdown report is generated from the classification and puts a leak first", () => {
  const leaking = classify({ fixtures: [fixtureCell("a.html", ["Alpha", "Beta", "Secret"]), fixtureCell("b.html", ["Gamma"])] }, cases);
  const report = { runId: RUN, outcome: "measured", reason: null, live: false, utc: "2026-11-02T00:00:00Z", durationMs: 1, stage: "classify",
    image: { id: "sha256:abc", created: "2026-11-02T00:00:00Z" },
    snapshotHash: { repo: "a".repeat(64), image: "b".repeat(64), match: false, method: "SHA-256 over LF-normalised bytes" },
    compose: { before: { services: ["a"], digest: "x" }, after: { services: ["a"], digest: "x" }, unchanged: true },
    probe: { environment: { uid: "65534:65534" }, calibration: { origin: { x: 0, y: 90 }, viewport: { width: 1024, height: 660 } },
      targets: { confirmed: false, fixturesWithCrossSiteTarget: [], expectedCrossSiteFixtures: [] }, blocked: [] },
    classification: leaking, recommendation: recommendation(leaking), cleanup: "complete", notes: [] };
  const markdown = renderMarkdown(report);
  assert.ok(markdown.startsWith("# Shadow DOM and iframe grounding spike — run 0123456789ab"));
  assert.ok(markdown.split("\n").slice(0, 4).some((line) => line.includes("SAFETY FAIL")));
  assert.ok(markdown.includes("| a.html |"));
  assert.ok(markdown.includes("| b.html |"));
  assert.ok(markdown.includes("Cleanup: **complete**"));
  assert.ok(markdown.includes("page-snapshot.mjs hash match **no**"));
  assert.ok(markdown.includes("## Recommendation"));
  assert.ok(!markdown.includes("undefined"));

  const stopped = renderMarkdown({ runId: RUN, outcome: "blocked", reason: "image_missing", stage: "preflight", live: false, utc: "x",
    durationMs: 1, image: null, compose: {}, classification: null, recommendation: null, cleanup: "not_needed" });
  assert.ok(stopped.includes("No table: the run stopped at `preflight` with `image_missing`"));
});

test("the real fixture set and cases describe the same controls", async () => {
  const root = path.resolve("scripts/spikes/shadow-frame/fixtures");
  const files = await readdir(root);
  const entries = JSON.parse(await readFile(path.join(root, "cases.json"), "utf8"));
  const vocabulary = new Set(["listed", "offscreen", "sensitive", "payment", "obstructed"]);
  const frames = new Set(["top", "same-origin", "cross-site", "nested"]);
  const shadows = new Set(["none", "open", "closed", "nested"]);
  assert.ok(entries.length >= 30);
  assert.equal(new Set(entries.map((item) => `${item.fixture}|${item.name}`)).size, entries.length);
  for (const item of entries) {
    assert.ok(vocabulary.has(item.expect), `bad expect ${item.expect}`);
    assert.ok(frames.has(item.frame), `bad frame ${item.frame}`);
    assert.ok(shadows.has(item.shadow), `bad shadow ${item.shadow}`);
    assert.ok(item.name && item.role && item.fixture.endsWith(".html"));
    assert.ok(files.includes(item.fixture), `${item.fixture} is missing`);
  }
  const pages = {};
  for (const name of files.filter((name) => name.endsWith(".html"))) pages[name] = await readFile(path.join(root, name), "utf8");
  const bundle = Object.values(pages).join("\n");
  for (const item of entries) assert.ok(bundle.includes(item.name), `no page contains ${item.name}`);
  assert.equal(Object.keys(pages).length, files.length - 1);
  for (const [name, text] of Object.entries(pages)) assert.ok(text.includes("__spikeClick"), `${name} has no click recorder`);
  assert.ok(entries.some((item) => item.shadow === "closed"));
  assert.ok(entries.some((item) => item.frame === "cross-site"));
  assert.ok(entries.some((item) => item.expect === "payment"));
});
