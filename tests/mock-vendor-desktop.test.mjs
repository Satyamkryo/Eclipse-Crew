import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, minimalEnvironment } from "../scripts/spikes/volume-isolation.mjs";
import { validateDesktopTarget, validateWorkspace, SETUP_CAPS } from "../scripts/desktop-agent.mjs";

const OWNER = "03500000-0000-4000-8000-000000000000";
const AGENT = "03500000-0000-4000-8000-000000000001";
const PEER = "03500000-0000-4000-8000-000000000002";

test("real desktop: guarded fixture lifecycle, both layouts, PDF, keyboard, responsive and denied paths", { timeout: 600000 }, async () => {
  const run = randomBytes(8).toString("hex"); const project = `eclipse035${run}`;
  const image = `${project}-desktop:qa`; const directory = path.resolve("data/spikes/task035", run);
  await mkdir(directory, { recursive: true });
  const report = { run, stage: "preflight", outcome: "incomplete", cleanup: "incomplete" };
  const invoke = async (args, input, timeout = 30000) => {
    const result = await runProcess("docker", args, { input, timeout, env: minimalEnvironment() });
    assert.ok(!result.timedOut && !result.oversized, `Docker ${args[0]} timed out or output overflowed`);
    assert.equal(result.status, 0, `Docker ${args[0]} failed at ${report.stage}: ${result.output.slice(-2000)}`);
    return result.output.trim();
  };
  const composeFile = path.join(directory, "compose.json"); const emptyEnv = path.join(directory, "empty.env");
  await writeFile(emptyEnv, "");
  const composeArgs = ["compose", "--env-file", emptyEnv, "-p", project, "-f", composeFile];
  const compose = (args, timeout) => invoke([...composeArgs, ...args], undefined, timeout);
  let created = false; let built = false; let container;
  try {
    assert.equal(await invoke(["info", "--format", "{{.OSType}}"]), "linux");
    report.stage = "build";
    await invoke(["build", "--label", `ai.eclipse.task035.run=${run}`, "-t", image, "-f", "docker/desktop/Dockerfile", "docker/desktop"], undefined, 240000); built = true;
    const config = { services: { desktop: { image, user: "0:0", read_only: true, cap_drop: ["ALL"], cap_add: SETUP_CAPS,
      security_opt: ["no-new-privileges:true", `seccomp=${path.resolve("docker/desktop/seccomp_profile.json")}`], init: false,
      shm_size: "128m", tmpfs: ["/tmp:uid=65534,gid=65534,mode=1777,size=536870912", "/run:uid=0,gid=0,mode=755,size=16777216"],
      command: ["python3", "/opt/eclipse/desktop/bootstrap.py"], environment: { DESKTOP_CONTROL_SECRET: randomBytes(32).toString("hex") },
      volumes: ["workspace:/workspace"], networks: ["isolated"], healthcheck: { test: ["CMD", "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", "health"], interval: "2s", timeout: "15s", retries: 20 },
    } }, volumes: { workspace: {} }, networks: { isolated: { internal: true } } };
    // Never put even a synthetic control token in evidence on disk.
    const secret = config.services.desktop.environment.DESKTOP_CONTROL_SECRET;
    config.services.desktop.environment.DESKTOP_CONTROL_SECRET = "${TASK035_CONTROL}";
    await writeFile(composeFile, JSON.stringify(config, null, 2));
    // The variable is passed only to this disposable Compose invocation, not the process global environment.
    const composeWithSecret = async (args) => {
      const result = await runProcess("docker", [...composeArgs, ...args], { env: { ...minimalEnvironment(), TASK035_CONTROL: secret }, timeout: 120000 });
      assert.equal(result.status, 0, "Disposable Compose failed"); return result.output;
    };
    report.stage = "start"; created = true;
    await composeWithSecret(["up", "-d", "--wait", "--wait-timeout", "90"]);
    report.composePs = (await composeWithSecret(["ps", "--format", "json"])).split(/\r?\n/).filter(Boolean).map((line) => {
      const state = JSON.parse(line); return { service: state.Service, state: state.State, health: state.Health };
    });
    container = (await invoke(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=desktop"]));
    assert.match(container, /^[a-f0-9]{12,64}$/);
    const [inspected] = JSON.parse(await invoke(["inspect", container]));
    validateDesktopTarget(inspected, project, JSON.parse(await readFile("docker/desktop/seccomp_profile.json", "utf8")));
    validateWorkspace(JSON.parse(await invoke(["volume", "inspect", inspected.Mounts[0].Name]))[0], project, inspected.Mounts[0].Name);
    report.stage = "agents";
    const admin = (args, input, timeout = 30000) => invoke(["exec", ...(input ? ["-i"] : []), "--user", "0:0", container, "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", ...args], input, timeout);
    const record = JSON.parse(await admin(["create", OWNER, AGENT]));
    const peer = JSON.parse(await admin(["create", OWNER, PEER]));
    const identity = Object.fromEntries(Object.entries(record).filter(([key]) => !["home", "downloads"].includes(key)));
    report.stage = "browser";
    const code = `
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { control } from '/opt/eclipse/desktop/mock-vendor/control.mjs';
import { startSession } from '/opt/eclipse/desktop/session-worker.mjs';
const record = ${JSON.stringify(identity)};
const home = process.env.HOME;
const first = await control('start'); assert.equal((await control('start')).url, first.url);
assert.equal((await control('status')).state, 'running');
const session = await startSession(record);
const findings = { lifecycle: true, externalRequests: [], widths: [] };
try {
 const page = session.context.pages()[0];
 page.on('request', request => { if (!request.url().startsWith(first.url) && !request.url().startsWith('chrome:')) findings.externalRequests.push(request.url()); });
 await page.goto(first.url); await page.locator('table').waitFor();
 assert.equal(await page.getByRole('link',{name:'Download PDF'}).count(), 2);
 await page.setViewportSize({width:1440,height:1000}); await page.screenshot({path:home+'/work/portal-a.png',fullPage:true});
 const link = page.getByRole('link',{name:'Download PDF'}).first();
 const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
 assert.equal(download.suggestedFilename(), 'DEMO-1002.pdf');
 await download.saveAs(home+'/work/DEMO-1002.pdf');
 const pdf = await readFile(home+'/work/DEMO-1002.pdf'); assert.ok(pdf.toString('ascii').includes('USD 240.00'));
 const {getDocument} = await import('/opt/eclipse/desktop/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
 const document = await getDocument({data:new Uint8Array(pdf),useSystemFonts:true}).promise;
 const extracted = (await (await document.getPage(1)).getTextContent()).items.map(item=>item.str).join(' ');
 assert.ok(extracted.includes('DEMO-1002') && extracted.includes('USD 240.00')); await document.destroy(); findings.pdfText=extracted;
 const preview = await session.context.newPage(); await preview.setViewportSize({width:612,height:792});
 const source = await readFile('/opt/eclipse/desktop/node_modules/pdfjs-dist/build/pdf.mjs','utf8');
 const worker = await readFile('/opt/eclipse/desktop/node_modules/pdfjs-dist/build/pdf.worker.mjs','utf8');
 await preview.evaluate(async ({source,worker,data})=>{
   document.body.style.margin='0';
   const moduleUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
   const workerUrl=URL.createObjectURL(new Blob([worker],{type:'text/javascript'}));
   const pdfjs=await import(moduleUrl); pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
   const doc=await pdfjs.getDocument({data:new Uint8Array(data),useSystemFonts:true}).promise;
   const pdfPage=await doc.getPage(1); const viewport=pdfPage.getViewport({scale:1});
   const canvas=document.createElement('canvas'); canvas.width=viewport.width; canvas.height=viewport.height; document.body.appendChild(canvas);
   await pdfPage.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
   await doc.destroy(); URL.revokeObjectURL(moduleUrl); URL.revokeObjectURL(workerUrl);
 },{source,worker,data:[...pdf]});
 await preview.screenshot({path:home+'/work/invoice-preview.png'}); await preview.close(); findings.pdfRendered=true;
 await page.getByText('Demo controls',{exact:true}).click();
 const switcher=page.getByRole('button',{name:'Switch to layout B'}); await switcher.focus();
 await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
 assert.equal(await switcher.evaluate(element=>getComputedStyle(element).outlineStyle), 'solid');
 await page.keyboard.press('Enter'); await page.locator('main[data-layout="b"]').waitFor();
 assert.equal(await page.getByRole('link',{name:'Download PDF'}).count(),0);
 assert.equal(await page.getByRole('link',{name:'Get invoice',exact:true}).count(),2);
 await page.screenshot({path:home+'/work/portal-b.png',fullPage:true});
 for (const width of [375,768,1280,1440]) {
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); findings.widths.push(width);
  if(width===375) await page.screenshot({path:home+'/work/portal-mobile.png',fullPage:true});
 }
 await page.getByLabel('Billing period').selectOption('2026-12');
 await Promise.all([page.waitForURL('**month=2026-12'),page.getByRole('button',{name:'Apply filter'}).click()]);
 assert.equal(await page.getByRole('heading',{name:'No invoices for this month'}).count(),1);
 await page.getByRole('link',{name:'Clear filters'}).click(); await page.locator('main[data-layout="b"]').waitFor();
 assert.equal(await page.getByRole('link',{name:'Get invoice',exact:true}).count(),4);
 await page.getByText('Demo controls',{exact:true}).click();
 await page.route('**/__demo/control',route=>route.abort());
 await page.getByRole('button',{name:'Reset demo'}).click(); await page.getByRole('alert').waitFor();
 assert.ok((await page.getByRole('alert').innerText()).includes("Couldn't update"));
 await page.unroute('**/__demo/control');
 await page.getByRole('button',{name:'Reset demo'}).click(); await page.locator('main[data-layout="a"]').waitFor();
 for(const width of [375,768,1280,1440]) { await page.setViewportSize({width,height:1000}); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); }
 assert.equal(findings.externalRequests.length,0); findings.layouts=true; findings.keyboard=true; findings.errorRecovery=true;
} finally { await session.close(); await control('stop'); }
assert.equal((await control('status')).state,'stopped');
await assert.rejects(()=>fetch(first.url));
await control('start'); assert.ok((await (await fetch((await control('status')).url)).text()).includes('data-layout="a"')); await control('stop');
// Unsafe state must fail closed without following or repairing it.
await symlink(home+'/work/DEMO-1002.pdf',home+'/work/.mock-vendor/instance.json');
await assert.rejects(()=>control('status')); await unlink(home+'/work/.mock-vendor/instance.json');
findings.unsafeStateDenied=true;
await writeFile(home+'/work/mock-vendor-qa.json',JSON.stringify(findings));
console.log(JSON.stringify(findings));
`;
    const imports = code.match(/^import .+;$/gm).join("\n");
    const diagnosticCode = `${imports}\ntry { ${code.replace(/^import .+;$/gm, "")} } catch(error) { console.log(JSON.stringify({failure:error.message,stack:error.stack?.split('\\n').slice(0,4)}));process.exitCode=1; }`;
    const browserOutput = await admin(["exec", OWNER, AGENT, "node", "--input-type=module", "-"], diagnosticCode, 65000);
    report.browser = JSON.parse(browserOutput.split(/\r?\n/).findLast((line) => line.startsWith('{"lifecycle"')));
    report.stage = "peer-denial";
    await admin(["exec", OWNER, AGENT, "node", "/opt/eclipse/desktop/mock-vendor/control.mjs", "start"]);
    const denied = await admin(["exec", OWNER, PEER, "node", "--input-type=module", "-"], `import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';await assert.rejects(()=>readFile(${JSON.stringify(record.home + "/work/.mock-vendor/instance.json")}),{code:'EACCES'});console.log('peer-denied');`);
    assert.ok(denied.includes("peer-denied")); report.peerStateDenied = true;
    await admin(["exec", OWNER, AGENT, "node", "/opt/eclipse/desktop/mock-vendor/control.mjs", "stop"]);
    for (const name of ["portal-a.png", "portal-b.png", "portal-mobile.png", "invoice-preview.png", "DEMO-1002.pdf", "mock-vendor-qa.json"])
      await invoke(["cp", `${container}:${record.home}/work/${name}`, path.join(directory, name)]);
    report.outcome = "passed"; report.stage = "complete"; void peer;
  } finally {
    if (created) {
      // Unique project; inspect every actual member before the scoped teardown.
      const ids = (await invoke(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`])).split(/\r?\n/).filter(Boolean);
      for (const id of ids) {
        const [value] = JSON.parse(await invoke(["inspect", id]));
        assert.equal(value.Config.Labels["com.docker.compose.project"], project);
        assert.equal(value.Config.Labels["com.docker.compose.service"], "desktop");
      }
      await compose(["down", "--volumes", "--remove-orphans"], 30000);
    }
    if (built) {
      const [value] = JSON.parse(await invoke(["image", "inspect", image]));
      assert.equal(value.Config.Labels["ai.eclipse.task035.run"], run);
      await invoke(["image", "rm", image]);
    }
    for (const args of [["ps", "-aq"], ["volume", "ls", "-q"], ["network", "ls", "-q"]])
      assert.equal(await invoke([...args, "--filter", `label=com.docker.compose.project=${project}`]), "");
    report.cleanup = "complete";
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`TASK-035 evidence: ${directory}`);
  }
});
