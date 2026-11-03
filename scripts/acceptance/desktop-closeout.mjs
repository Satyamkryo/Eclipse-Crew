// Approved remaining-work closeout: real browser scanner and document fixtures
// in a mount-free, network-free desktop container. No live agents are touched.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const run = randomBytes(6).toString("hex");
const name = `eclipse-closeout-desktop-${run}`;
const labelKey = "ai.eclipse.closeout";
const evidence = path.resolve("test-results/closeout-2026-11-04", `desktop-${run}`);
mkdirSync(evidence, { recursive: true });
const invoke = (args, input, timeout = 30_000) => spawnSync("docker", args, { input, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const checked = (result, what) => { assert.equal(result.status, 0, `${what}: ${result.stderr ?? ""}`); return result.stdout.trim(); };
const image = checked(invoke(["image", "inspect", "main-desktop:latest", "--format", "{{.Id}}"]), "inspect desktop image");
const files = ["tests/page-snapshot.test.mjs", "tests/doc-search.test.mjs", "tests/agent-files.test.mjs",
  ...readdirSync("docker/desktop").filter(file => file.endsWith(".mjs")).map(file => `docker/desktop/${file}`),
  ...readdirSync("scripts/spikes/shadow-frame/fixtures").filter(file => file.endsWith(".html")).map(file => `scripts/spikes/shadow-frame/fixtures/${file}`)];
const manifest = files.map(file => ({ file, data: readFileSync(file).toString("base64") }));
const summary = { image, run, outcome: "incomplete", cleanup: "pending", sourceHashes: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])) };
let started = false;
try {
  checked(invoke(["run", "-d", "--name", name, "--label", `${labelKey}=${run}`, "--init", "--network", "none",
    "--user", "65534:65534", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--security-opt", `seccomp=${path.resolve("docker/desktop/seccomp_profile.json")}`, "--shm-size", "128m",
    "--tmpfs", "/tmp:rw,nosuid,size=536870912,mode=1777", image, "sleep", "infinity"]), "start exact disposable image");
  started = true;
  for (const file of ["page-snapshot.mjs", "file-tools.mjs", "doc-search.mjs"]) {
    const remote = checked(invoke(["exec", name, "sha256sum", `/opt/eclipse/desktop/${file}`]), "verify image source").split(/\s/)[0];
    assert.equal(remote, summary.sourceHashes[`docker/desktop/${file}`], `${file} matches current source`);
  }
  const stage = `import fs from 'node:fs';import path from 'node:path';const root='/tmp/ec-closeout';for(const{file,data}of JSON.parse(fs.readFileSync(0,'utf8'))){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.from(data,'base64'));}fs.symlinkSync('/opt/eclipse/desktop/node_modules',root+'/node_modules');`;
  checked(invoke(["exec", "-i", name, "node", "--input-type=module", "-e", stage], JSON.stringify(manifest)), "stage bounded source manifest");
  checked(invoke(["exec", "-d", name, "Xvfb", ":99", "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-ac"]), "start private fixture display");
  checked(invoke(["exec", name, "sh", "-c", "for n in 1 2 3 4 5 6 7 8 9 10; do DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1"]), "fixture display ready");
  const result = invoke(["exec", "--env", "DISPLAY=:99", "--env", "ECLIPSE_PAGE_SNAPSHOT=1", "--workdir", "/tmp/ec-closeout", name,
    "node", "--test", "tests/page-snapshot.test.mjs", "tests/doc-search.test.mjs", "tests/agent-files.test.mjs"], undefined, 180_000);
  writeFileSync(path.join(evidence, "tests.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  summary.exitCode = result.status;
  checked(result, "desktop document/scanner tests");
  summary.outcome = "passed";
} finally {
  if (started) {
    const actual = checked(invoke(["inspect", "--format", `{{ index .Config.Labels "${labelKey}" }}`, name]), "verify cleanup label");
    assert.equal(actual, run);
    checked(invoke(["rm", "-f", "-v", name]), "remove exact fixture and anonymous volumes");
    summary.cleanup = "complete";
  }
  writeFileSync(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ evidence, outcome: summary.outcome, exitCode: summary.exitCode, cleanup: summary.cleanup }));
}
