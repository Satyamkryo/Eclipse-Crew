// Shadow DOM and iframe grounding spike: host harness. Runs on the owner's machine, starts one labelled
// throwaway desktop container, feeds it the probe and fixtures, classifies what the probe measured and writes a report.
// It never builds or pulls an image, never mounts anything, and removes only the container this run created.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const IMAGE = "main-desktop:latest";
export const LABEL_KEY = "ai.eclipse.spike";
export const SCANNERS = ["current", "A", "B"];
export const SPEED_LIMIT_MS = 1500;
export const HEAVY_FIXTURE = "heavy.html";
export const PROBE_TIMEOUT_MS = 600000;
export const DOCKER_FALLBACK = "E:\\Apps\\Docker\\resources\\bin\\docker.exe";
const SPIKE_ROOT = path.resolve("scripts/spikes/shadow-frame");
const SECCOMP = path.resolve("docker/desktop/seccomp_profile.json");
const OUTPUT_ROOT = path.resolve("data/spikes/shadow-frame");
const LISTED = "listed";
const LEAK_EXPECTS = new Set(["sensitive", "payment"]);

class SpikeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const check = (value, code) => { if (!value) throw new SpikeError(code); };

export const runIdFor = () => randomBytes(6).toString("hex");
export const containerName = (runId) => `eclipse-spike-sf-${runId}`;
export const runLabel = (runId) => `${LABEL_KEY}=shadow-frame-${runId}`;

export function containerArgs(runId, seccompPath, live = false) {
  check(/^[\da-f]{12}$/.test(runId), "invalid_run");
  check(path.isAbsolute(String(seccompPath)), "seccomp_path_absolute");
  return ["run", "-d", "--name", containerName(runId), "--label", `ai.eclipse.spike=shadow-frame-${runId}`, "--init",
    "--user", "65534:65534", "--read-only", "--cap-drop=ALL",
    "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${seccompPath}`,
    "--shm-size", "128m", "--tmpfs", "/tmp:rw,nosuid,size=536870912,mode=1777",
    "--network", live ? "bridge" : "none", IMAGE, "sleep", "infinity"];
}

// The only container this run may ever remove is the one it started, proved by its own label.
export function cleanupTarget(inspected, runId) {
  check(Array.isArray(inspected) && inspected.length === 1, "cleanup_ambiguous");
  const container = inspected[0];
  const labels = container?.Config?.Labels ?? {};
  check(container?.Name === `/${containerName(runId)}`, "cleanup_refused");
  check(labels[LABEL_KEY] === `shadow-frame-${runId}`, "cleanup_refused");
  // Never remove a container Compose itself started. A Compose-built image carries its project and service
  // labels into every container made from it, so only Compose's own runtime labels count as managed.
  check(!labels["com.docker.compose.container-number"] && !labels["com.docker.compose.config-hash"] &&
    !labels["com.docker.compose.project.working_dir"], "cleanup_refused");
  check(typeof container?.Id === "string" && container.Id.length > 0, "cleanup_refused");
  return container.Id;
}

const expectedOf = (cases, fixture, expect) => cases.filter((item) => item.fixture === fixture && item.expect === expect);

// Code-written classification. Missing data is never a pass.
export function classify(probe, cases) {
  const fixtures = [];
  for (const fixture of [...new Set(cases.map((item) => item.fixture))]) {
    const entry = (probe?.fixtures ?? []).find((item) => item.fixture === fixture) ?? null;
    const cell = { fixture, outcome: entry?.outcome ?? "absent", scanners: {} };
    const listedCases = expectedOf(cases, fixture, LISTED);
    const leakCases = cases.filter((item) => item.fixture === fixture && LEAK_EXPECTS.has(item.expect));
    const offCases = cases.filter((item) => item.fixture === fixture && item.expect === "offscreen");
    const obstructedCases = cases.filter((item) => item.fixture === fixture && item.expect === "obstructed");
    for (const scanner of SCANNERS) {
      const scan = entry?.scans?.[scanner] ?? null;
      const clicks = entry?.clicks?.[scanner] ?? null;
      if (!scan || !Array.isArray(scan.found)) {
        cell.scanners[scanner] = { status: "blocked", expected: listedCases.length, found: 0, clicksLanded: 0,
          p95: entry?.timings?.[scanner]?.p95 ?? null, frames: 0, paymentFrames: 0, truncated: false,
          leaked: [], offscreenListed: [], obstructedListed: [], notFound: listedCases.map((item) => item.name), clickMisses: [],
          reason: entry?.reason ?? "scan_data_absent" };
        continue;
      }
      const foundNames = new Set(scan.found.map((control) => control.name));
      const foundListed = listedCases.filter((item) => foundNames.has(item.name));
      const landedByName = new Map((clicks?.results ?? []).filter((item) => !item.skipped).map((item) => [item.name, item.ok === true]));
      const landed = foundListed.filter((item) => landedByName.get(item.name) === true);
      const attempted = foundListed.every((item) => landedByName.has(item.name));
      const leaked = leakCases.filter((item) => foundNames.has(item.name));
      const offscreenListed = offCases.filter((item) => foundNames.has(item.name));
      const obstructedListed = obstructedCases.filter((item) => foundNames.has(item.name));
      const clean = !leaked.length && !offscreenListed.length && !obstructedListed.length;
      const complete = !!entry && entry.outcome === "complete" && clicks?.expected === foundListed.length;
      let status;
      if (foundListed.length === listedCases.length && landed.length === foundListed.length && attempted && clean && complete) status = "pass";
      else if (foundListed.length > 0) status = "partial";
      else status = "fail";
      cell.scanners[scanner] = { status, expected: listedCases.length, found: foundListed.length, clicksLanded: landed.length,
        p95: entry?.timings?.[scanner]?.p95 ?? null, frames: scan.frames ?? 0, paymentFrames: scan.paymentFrames ?? 0,
        truncated: scan.truncated === true, leaked: leaked.map((item) => item.name), offscreenListed: offscreenListed.map((item) => item.name),
        obstructedListed: obstructedListed.map((item) => item.name),
        notFound: listedCases.filter((item) => !foundNames.has(item.name)).map((item) => item.name),
        clickMisses: foundListed.filter((item) => landedByName.get(item.name) !== true).map((item) => item.name),
        verify: entry?.verify?.[scanner] ?? null, counts: scan.counts ?? {} };
    }
    fixtures.push(cell);
  }
  const heavy = fixtures.find((cell) => cell.fixture === HEAVY_FIXTURE);
  const speed = Object.fromEntries(SCANNERS.map((scanner) => {
    const p95 = heavy?.scanners?.[scanner]?.p95 ?? null;
    return [scanner, { p95, status: p95 === null ? "blocked" : p95 <= SPEED_LIMIT_MS ? "pass" : "fail",
      truncated: heavy?.scanners?.[scanner]?.truncated === true }];
  }));
  const safety = Object.fromEntries(SCANNERS.map((scanner) => {
    const leaks = fixtures.flatMap((cell) => [
      ...cell.scanners[scanner].leaked.map((name) => ({ fixture: cell.fixture, name, kind: "sensitive_or_payment" })),
      ...cell.scanners[scanner].offscreenListed.map((name) => ({ fixture: cell.fixture, name, kind: "offscreen" })),
      ...cell.scanners[scanner].obstructedListed.map((name) => ({ fixture: cell.fixture, name, kind: "obstructed" })),
    ]);
    return [scanner, { status: leaks.length ? "fail" : "pass", leaks }];
  }));
  const perScanner = Object.fromEntries(SCANNERS.map((scanner) => [scanner, {
    pass: fixtures.filter((cell) => cell.scanners[scanner].status === "pass").length,
    partial: fixtures.filter((cell) => cell.scanners[scanner].status === "partial").length,
    fail: fixtures.filter((cell) => cell.scanners[scanner].status === "fail").length,
    blocked: fixtures.filter((cell) => cell.scanners[scanner].status === "blocked").length,
    listedFound: fixtures.reduce((total, cell) => total + cell.scanners[scanner].found, 0),
    listedExpected: fixtures.reduce((total, cell) => total + cell.scanners[scanner].expected, 0),
    clicksLanded: fixtures.reduce((total, cell) => total + cell.scanners[scanner].clicksLanded, 0),
    speed: speed[scanner].status, safety: safety[scanner].status,
  }]));
  const unsolved = [];
  for (const item of cases.filter((entry) => entry.expect === LISTED)) {
    const cell = fixtures.find((entry) => entry.fixture === item.fixture);
    if (!cell) continue;
    const solved = SCANNERS.some((scanner) => !cell.scanners[scanner].notFound.includes(item.name) &&
      (cell.scanners[scanner].clicksLanded ?? 0) > 0 && !cell.scanners[scanner].clickMisses.includes(item.name));
    if (!solved) unsolved.push({ fixture: item.fixture, name: item.name, role: item.role, frame: item.frame, shadow: item.shadow });
  }
  return { fixtures, speed, safety, perScanner, unsolved, fixtureCount: fixtures.length };
}

// The recommendation cites only numbers from the table.
export function recommendation(classification) {
  const passed = (scanner) => classification.fixtures.filter((cell) => cell.scanners[scanner].status === "pass").map((cell) => cell.fixture);
  const usable = SCANNERS.filter((scanner) => classification.perScanner[scanner].safety === "pass");
  const ranked = [...usable].sort((a, b) => classification.perScanner[b].clicksLanded - classification.perScanner[a].clicksLanded);
  const best = ranked[0] ?? null;
  const facts = {
    safety: Object.fromEntries(SCANNERS.map((scanner) => [scanner, classification.perScanner[scanner].safety])),
    speed: Object.fromEntries(SCANNERS.map((scanner) => [scanner, `${classification.speed[scanner].status} (p95 ${classification.speed[scanner].p95 ?? "none"} ms)`])),
    clicks: Object.fromEntries(SCANNERS.map((scanner) => [scanner, `${classification.perScanner[scanner].clicksLanded}/${classification.perScanner[scanner].listedExpected} listed targets clicked`])),
    fixtures: Object.fromEntries(SCANNERS.map((scanner) => [scanner, `${classification.perScanner[scanner].pass}/${classification.fixtureCount} pass, ${classification.perScanner[scanner].partial} partial, ${classification.perScanner[scanner].fail} fail, ${classification.perScanner[scanner].blocked} blocked`])),
    uniqueToA: passed("A").filter((fixture) => !passed("B").includes(fixture) && !passed("current").includes(fixture)),
    uniqueToB: passed("B").filter((fixture) => !passed("A").includes(fixture) && !passed("current").includes(fixture)),
    unsolved: classification.unsolved.map((item) => `${item.fixture}/${item.name} (${item.shadow} shadow, ${item.frame} frame)`),
  };
  let choice;
  if (!usable.length) choice = "don't build: every scanner lists a sensitive, payment, offscreen or obstructed control, so none is safe as a grounding source";
  else if (!best || classification.perScanner[best].clicksLanded === 0) choice = "don't build: no scanner landed a single listed target click, so shadow and frame grounding is not workable yet";
  else if (best !== "current" && facts.uniqueToA.length && facts.uniqueToB.length) choice = "combine them: A and B each pass fixtures the other cannot, so run A and fall back to B";
  else if (best === "A") choice = "build A (the DOM walk)";
  else if (best === "B") choice = "build B (the accessibility tree)";
  else choice = "don't build: the current scanner passes everything both spikes pass, so the gap is not in the scanner";
  return { choice, facts };
}

export async function collectFixtures(root = path.join(SPIKE_ROOT, "fixtures")) {
  const names = (await readdir(root)).filter((name) => /^[\w.-]+\.(html|json)$/.test(name)).sort();
  check(names.length >= 10, "fixtures_missing");
  check(names.includes("cases.json"), "cases_missing");
  const fixtures = {};
  for (const name of names) fixtures[name] = await readFile(path.join(root, name), "utf8");
  return fixtures;
}

export const normalizeForHash = (text) => text.replace(/\r\n/g, "\n");
export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function runProcess(executable, args, { input, timeout = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { resolve({ status: null, missing: true, stdout: "", stderr: "" }); return; }
    let stdout = "", stderr = "", oversized = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeout);
    child.stdout.on("data", (chunk) => { if (stdout.length < 32 * 1024 * 1024) stdout += chunk.toString("utf8"); else oversized = true; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 200 * 1024) stderr += chunk.toString("utf8"); });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    child.once("error", () => { clearTimeout(timer); resolve({ status: null, missing: true, stdout, stderr }); });
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut, oversized }); });
  });
}

export async function resolveDocker(runner = runProcess) {
  const attempt = await runner("docker", ["--version"], { timeout: 20000 });
  if (!attempt.missing && attempt.status === 0) return "docker";
  if (await access(DOCKER_FALLBACK).then(() => true, () => false)) return DOCKER_FALLBACK;
  return null;
}

const lastJsonLine = (text) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].startsWith("{")) continue;
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  return null;
};

const parseComposeLines = (text) => {
  let rows = [];
  try {
    const whole = JSON.parse(text);
    rows = Array.isArray(whole) ? whole : [whole];
  } catch {
    rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }
  return rows.map((row) => `${row.Name ?? "?"}|${row.State ?? "?"}|${row.Status ?? "?"}`).sort();
};

export async function runSpike({ runner = runProcess, dockerPath = "docker", live = false, evidenceRoot = OUTPUT_ROOT,
  seccompPath = SECCOMP, fixturesRoot = path.join(SPIKE_ROOT, "fixtures"), repoRoot = path.resolve(".") } = {}) {
  const runId = runIdFor();
  const container = containerName(runId);
  const started = performance.now();
  const directory = path.join(evidenceRoot, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { spike: "shadow-frame-grounding", runId, container, label: `ai.eclipse.spike=shadow-frame-${runId}`, live,
    utc: new Date().toISOString(), node: process.version, platform: process.platform, outcome: "blocked", stage: "preflight",
    image: null, snapshotHash: null, compose: { before: null, after: null, unchanged: null }, probe: null, classification: null,
    recommendation: null, cleanup: "not_started", notes: [], containerStarted: false };
  const invoke = async (args, options = {}) => {
    const value = await runner(dockerPath, args, { ...options, cwd: options.cwd ?? repoRoot, timeout: options.timeout ?? 60000 });
    check(!value?.missing, "docker_unavailable");
    check(!value.timedOut, "docker_timeout");
    check(!value.oversized, "docker_output_too_large");
    if (options.allowFailure) return value;
    check(value.status === 0, options.failureCode ?? "docker_failed");
    return value;
  };
  const composePs = async () => {
    const value = await runner(dockerPath, ["compose", "ps", "--format", "json"], { cwd: repoRoot, timeout: 30000 }).catch(() => null);
    if (!value || value.missing || value.status !== 0) return { services: [], digest: "unavailable" };
    const services = parseComposeLines(value.stdout);
    return { services, digest: sha256(Buffer.from(services.join("\n"))) };
  };
  try {
    report.stage = "preflight";
    report.dockerPath = dockerPath;
    const composed = await composePs();
    report.compose.before = composed;
    const image = await invoke(["image", "inspect", IMAGE, "--format", "{{.Id}}\t{{.Created}}"], { allowFailure: true, timeout: 60000 });
    check(image.status === 0 && !!image.stdout.trim(), "image_missing");
    const [imageId, created] = image.stdout.trim().split("\t");
    check(imageId && created, "image_missing");
    report.image = { name: IMAGE, id: imageId, created };
    const already = await invoke(["ps", "-a", "--filter", `label=${runLabel(runId)}`, "--format", "{{.ID}}"], { timeout: 30000 });
    check(!already.stdout.trim(), "container_exists");

    report.stage = "start";
    await invoke(containerArgs(runId, seccompPath, live), { timeout: 180000, failureCode: "container_start_failed" });
    report.containerStarted = true;

    report.stage = "snapshot-hash";
    const repoFile = normalizeForHash(await readFile(path.join(repoRoot, "docker/desktop/page-snapshot.mjs"), "utf8"));
    const imageFile = await invoke(["exec", container, "sh", "-c", "tr -d '\\r' < /opt/eclipse/desktop/page-snapshot.mjs | sha256sum"],
      { allowFailure: true, timeout: 60000 });
    report.snapshotHash = { method: "SHA-256 over LF-normalised bytes", repo: sha256(Buffer.from(repoFile)),
      image: imageFile.status === 0 ? imageFile.stdout.trim().split(/\s+/)[0] : null,
      match: imageFile.status === 0 && imageFile.stdout.trim().split(/\s+/)[0] === sha256(Buffer.from(repoFile)) };
    if (!report.snapshotHash.match) report.notes.push("The image's page-snapshot.mjs differs from the repo file (or cannot be read); the Current column runs the image copy.");

    report.stage = "transport";
    const fixtures = await collectFixtures(fixturesRoot);
    for (const [name, target] of [["scanners.mjs", "/tmp/scanners.mjs"], ["probe.mjs", "/tmp/probe.mjs"]]) {
      const source = normalizeForHash(await readFile(path.join(SPIKE_ROOT, name), "utf8"));
      await invoke(["exec", "-i", container, "sh", "-c", `cat > ${target}`], { input: source, timeout: 60000 });
      report.transport ??= {};
      report.transport[name] = source.length;
    }
    report.transport.fixtures = Object.keys(fixtures).length;

    report.stage = "probe";
    const probeRun = await invoke(["exec", "-i", container, "node", "/tmp/probe.mjs", ...(live ? ["--live"] : [])],
      { input: JSON.stringify(fixtures), timeout: PROBE_TIMEOUT_MS });
    const probeResult = lastJsonLine(probeRun.stdout);
    report.probeRun = { exitStatus: probeRun.status, stdoutBytes: probeRun.stdout.length,
      stdoutLines: probeRun.stdout.split(/\r?\n/).filter(Boolean).length, stdoutTail: probeRun.stdout.slice(-1500),
      stderrTail: (probeRun.stderr ?? "").slice(-1500) };
    check(probeResult, "probe_output_unparsable");
    report.probe = probeResult;
    const cases = JSON.parse(fixtures["cases.json"]);
    report.casesCount = cases.length;

    report.stage = "classify";
    report.classification = classify(probeResult, cases);
    report.recommendation = recommendation(report.classification);
    report.outcome = probeResult.outcome === "blocked" ? "blocked" : "measured";
    report.reason = probeResult.reason ?? null;
    if (probeResult.outcome === "partial") report.notes.push("The probe recorded blocked steps; affected cells are marked from its own report.");
  } catch (error) {
    const code = error instanceof SpikeError ? error.code : "unexpected_failure";
    report.outcome = "blocked";
    report.reason = code;
    report.error = String(error?.message ?? error).slice(0, 300);
  } finally {
    report.durationMs = Math.round(performance.now() - started);
    if (report.containerStarted) {
      try {
        const inspected = await runner(dockerPath, ["inspect", "--type=container", container], { cwd: repoRoot, timeout: 60000 });
        check(!inspected.missing && inspected.status === 0, "cleanup_refused");
        const id = cleanupTarget(JSON.parse(inspected.stdout), runId);
        const removed = await runner(dockerPath, ["rm", "--force", id], { cwd: repoRoot, timeout: 60000 });
        const left = await runner(dockerPath, ["ps", "-a", "--filter", `label=${runLabel(runId)}`, "--format", "{{.ID}}"], { cwd: repoRoot, timeout: 60000 });
        report.cleanup = removed.status === 0 && !left.stdout.trim() ? "complete" : "incomplete";
      } catch {
        report.cleanup = "refused";
      }
    } else report.cleanup = "not_needed";
    report.compose.after = await composePs();
    report.compose.unchanged = typeof report.compose.before?.digest === "string" && report.compose.before.digest !== "unavailable" &&
      report.compose.before.digest === report.compose.after?.digest;
    report.reportPaths = { directory: path.relative(repoRoot, directory).replace(/\\/g, "/"), json: "report.json", markdown: "report.md" };
    await writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(directory, "report.md"), renderMarkdown(report), { mode: 0o600 });
  }
  return { report, directory };
}

export function renderMarkdown(report) {
  const classification = report.classification;
  const lines = [`# Shadow DOM and iframe grounding spike — run ${report.runId}`, ""];
  if (classification) {
    const leaks = SCANNERS.flatMap((scanner) => classification.safety[scanner].leaks.map((leak) => `${scanner}: ${leak.fixture}/${leak.name} (${leak.kind})`));
    if (leaks.length) lines.push(`**SAFETY FAIL — controls listed that must never be listed: ${leaks.join("; ")}**`, "");
  }
  lines.push(`Outcome: \`${report.outcome}${report.reason ? ` (${report.reason})` : ""}\` · Image \`${report.image?.id ?? "not read"}\` created ${report.image?.created ?? "?"} · Live phase: ${report.live ? "yes" : "no"} · ${report.utc} · ${report.durationMs ?? "?"} ms`, "");
  if (!classification) {
    lines.push(`No table: the run stopped at \`${report.stage}\` with \`${report.reason ?? "unknown"}\`${report.error ? ` — ${report.error}` : ""}.`, "");
    return `${lines.join("\n")}\n`;
  }
  const column = (cell, scanner) => {
    const item = cell.scanners[scanner];
    return `${item.status} · found ${item.found}/${item.expected} · clicks ${item.clicksLanded} · p95 ${item.p95 ?? "—"} ms${item.truncated ? " · capped" : ""}${item.leaked.length || item.offscreenListed.length || item.obstructedListed.length ? " · LEAK" : ""}`;
  };
  lines.push("## Fixture × scanner", "", "| Fixture | Current | A (DOM walk) | B (accessibility) |", "|---|---|---|---|");
  for (const cell of classification.fixtures) lines.push(`| ${cell.fixture} | ${column(cell, "current")} | ${column(cell, "A")} | ${column(cell, "B")} |`);
  lines.push("", "## Totals", "", "| Scanner | Fixtures pass | Partial | Fail | Blocked | Listed found | Clicks landed | Speed on heavy | Safety |", "|---|---|---|---|---|---|---|---|---|");
  for (const scanner of SCANNERS) {
    const summary = classification.perScanner[scanner];
    lines.push(`| ${scanner} | ${summary.pass}/${classification.fixtureCount} | ${summary.partial} | ${summary.fail} | ${summary.blocked} | ${summary.listedFound}/${summary.listedExpected} | ${summary.clicksLanded} | ${classification.speed[scanner].status} (${classification.speed[scanner].p95 ?? "none"} ms) | ${summary.safety} |`);
  }
  lines.push("", "## Environment, safety and cleanup", "");
  const targets = report.probe?.targets;
  lines.push(`- Out-of-process cross-site frames confirmed: **${targets?.confirmed === true ? "yes" : "no"}** — fixtures showing a localhost:8082 iframe target: ${JSON.stringify(targets?.fixturesWithCrossSiteTarget ?? [])}; fixtures expected to: ${JSON.stringify(targets?.expectedCrossSiteFixtures ?? [])}.`);
  lines.push(`- Calibration origin: ${JSON.stringify(report.probe?.calibration?.origin ?? null)}; viewport ${JSON.stringify(report.probe?.calibration?.viewport ?? null)}.`);
  lines.push(`- Safety per scanner: ${SCANNERS.map((scanner) => `${scanner} ${classification.safety[scanner].status}${classification.safety[scanner].leaks.length ? ` (leaked ${classification.safety[scanner].leaks.map((leak) => `${leak.fixture}/${leak.name}`).join(", ")})` : ""}`).join("; ")}.`);
  lines.push(`- Image \`${report.image?.id}\` created ${report.image?.created}; page-snapshot.mjs hash match **${report.snapshotHash?.match === true ? "yes" : "no"}** (repo ${String(report.snapshotHash?.repo).slice(0, 12)} / image ${String(report.snapshotHash?.image).slice(0, 12)}, ${report.snapshotHash?.method}).`);
  lines.push(`- Cleanup: **${report.cleanup}**. Compose stack unchanged before/after: **${report.compose?.unchanged === true ? "yes" : "no"}** (${report.compose?.before?.services?.length ?? 0} lines before, ${report.compose?.after?.services?.length ?? 0} after, digest ${String(report.compose?.after?.digest).slice(0, 12)}).`);
  lines.push(`- Probe environment: ${JSON.stringify(report.probe?.environment ?? null)}.`);
  if (report.probe?.blocked?.length) lines.push(`- Blocked steps the probe recorded: ${report.probe.blocked.map((item) => `${item.stage}: ${item.error}`).join(" | ")}`);
  if (classification.unsolved.length) lines.push(`- Listed cases no scanner solved: ${classification.unsolved.map((item) => `${item.fixture}/${item.name} (${item.shadow} shadow, ${item.frame} frame)`).join(", ")}.`);
  if (report.notes?.length) lines.push(`- Notes: ${report.notes.join(" ")}`);
  lines.push("", "## Recommendation", "");
  const facts = report.recommendation?.facts ?? {};
  lines.push(`${report.recommendation?.choice ?? "No recommendation: this run produced no classification."} — from the table only: clicks landed ${JSON.stringify(facts.clicks ?? {})}; fixtures ${JSON.stringify(facts.fixtures ?? {})}; speed ${JSON.stringify(facts.speed ?? {})}; safety ${JSON.stringify(facts.safety ?? {})}; fixtures only A passes ${JSON.stringify(facts.uniqueToA ?? [])}; only B ${JSON.stringify(facts.uniqueToB ?? [])}; still unsolved ${JSON.stringify(facts.unsolved ?? [])}.`);
  if (report.live) {
    lines.push("", "## Live pages", "");
    lines.push("| Page | Outcome | Current | A | B | iframe targets |", "|---|---|---|---|---|---|");
    for (const page of report.probe?.live ?? []) {
      const cell = (scanner) => page[scanner] ? `${page[scanner].controls} controls · ${page[scanner].paymentFrames} payment · p95 ${page[scanner].p95} ms` : "—";
      lines.push(`| ${page.url} | ${page.outcome} | ${cell("current")} | ${cell("A")} | ${cell("B")} | ${page.outOfProcessFrames ?? "—"} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argument = process.argv.slice(2);
  if (argument.includes("--help")) {
    console.log("Usage: node scripts/spikes/shadow-frame/run.mjs [--live]\nStarts one hardened throwaway desktop container, scans the local shadow/iframe fixtures, and writes data/spikes/shadow-frame/<runId>/report.md. --live also loads four public pages read-only.");
    return;
  }
  check(argument.every((value) => value === "--live"), "invalid_arguments");
  const dockerPath = await resolveDocker();
  check(dockerPath, "docker_unavailable");
  const { report, directory } = await runSpike({ dockerPath, live: argument.includes("--live") });
  console.log(JSON.stringify({ outcome: report.outcome, reason: report.reason ?? null, runId: report.runId,
    cleanup: report.cleanup, safety: report.classification ? SCANNERS.map((scanner) => `${scanner}:${report.classification.safety[scanner].status}`).join(",") : null,
    report: path.join(directory, "report.md") }));
  if (report.outcome !== "measured") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
