import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { minimalEnvironment, reserveEvidence } from "../scripts/spikes/volume-isolation.mjs";

test("TASK-028 disposable Chromium: consecutive guarded postconditions, focus, exclusions and calibrated clicks", { timeout: 360000 }, async () => {
  const project = `eclipse028${randomBytes(8).toString("hex")}`;
  const evidence = await reserveEvidence(path.resolve("data/spikes/task-028"));
  const summary = { task: "TASK-028", outcome: "incomplete", cleanup: "pending", checks: [] };
  let docker = "docker";
  if (process.platform === "win32") { try { await access("E:\\Apps\\Docker\\resources\\bin\\docker.exe"); docker = "E:\\Apps\\Docker\\resources\\bin\\docker.exe"; } catch { /* PATH fallback */ } }
  const env = { ...minimalEnvironment(), DESKTOP_CONTROL_SECRET: randomBytes(32).toString("hex"), POSTGRES_BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_APP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_MIGRATOR_PASSWORD: randomBytes(24).toString("hex") };
  const empty = path.join(evidence.directory, "empty.env"), override = path.join(evidence.directory, "override.json");
  await writeFile(empty, "", { flag: "wx", mode: 0o600 });
  await writeFile(override, JSON.stringify({ services: { desktop: { labels: { "ai.eclipse.task028.run": project }, build: { labels: { "ai.eclipse.task028.run": project } } } } }), { flag: "wx", mode: 0o600 });
  const run = (args, timeout = 60000) => {
    const result = spawnSync(docker, args, { env, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, String(result.stderr).slice(0, 2000)); return result.stdout.trim();
  };
  const prefix = ["compose", "--env-file", empty, "--project-name", project, "--file", path.resolve("docker-compose.yml"), "--file", override];
  const compose = (args, timeout) => run([...prefix, ...args], timeout);
  let built = false;
  try {
    compose(["build", "desktop"], 300000); built = true;
    compose(["up", "-d", "--no-build", "--wait", "desktop"], 60000);
    const container = compose(["ps", "-q", "desktop"]);
    const owner = "11111111-1111-4111-8111-111111111111", agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const admin = (command, args = []) => run(["exec", "--user", "0:0", container, "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", command, owner, agent, ...args]);
    const identity = JSON.parse(admin("create"));
    const record = { ownerId: owner, agentId: agent, uid: identity.uid, gid: identity.uid, name: identity.name, state: "ready" };
    const html = '<body style="margin:0;height:3000px"><button style="position:absolute;left:100px;top:100px;width:120px;height:40px" onclick="document.title=\'saved\'">Save</button>' +
      '<button style="position:absolute;left:100px;top:200px">Covered</button><div style="position:absolute;left:90px;top:190px;width:150px;height:60px;background:black"></div>' +
      '<input aria-label="Email address" value="private@example.com" style="position:absolute;left:100px;top:280px">' +
      '<input type="password" aria-label="Account password" style="position:absolute;left:100px;top:330px">' +
      '<input autocomplete="one-time-code" aria-label="Sign in code" style="position:absolute;left:100px;top:370px">' +
      '<iframe srcdoc="<button>Inner</button>" style="position:absolute;left:100px;top:420px"></iframe>' +
      '<button style="position:absolute;left:100px;top:2000px">Far below</button></body>';
    const code = `import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';import{startSession,dispatchOperation}from'/opt/eclipse/desktop/session-worker.mjs';
      const s=await startSession(${JSON.stringify(record)});const pause=ms=>new Promise(r=>setTimeout(r,ms));
      try{const page=s.context.pages()[0];await page.goto('about:blank');await page.setContent(${JSON.stringify(html)});await page.bringToFront();await pause(300);
        const read=()=>dispatchOperation(s,'page.snapshot');const verify=(kind,value)=>dispatchOperation(s,'page.verify',{predicate:{kind,value}});
        const first=await read();assert.deepEqual(first.elements.map(e=>e.name).sort(),['Email address','Save']);
        for(let i=0;i<4;i++)assert.equal((await verify('control_present','Save')).status,'pass','consecutive read '+i);
        for(const name of ['Missing','Covered','Far below','Account password','Sign in code','Inner'])assert.equal((await verify('control_present',name)).status,'fail',name);
        assert.equal((await verify('control_absent','Missing')).status,'pass');
        await page.locator('input[aria-label="Email address"]').focus();const focused=await read();assert.equal(focused.elements.find(e=>e.name==='Email address').focused,true);assert.ok(!JSON.stringify(focused).includes('private@example.com'));
        await page.locator('input[type="password"]').focus();assert.ok(!(await read()).elements.some(e=>e.focused));
        await page.evaluate(()=>{const b=document.createElement('button');b.id='duplicate';b.textContent='Save';b.style.cssText='position:absolute;left:400px;top:100px';document.body.append(b);});
        assert.equal((await verify('control_present','Save')).status,'unknown');await page.locator('#duplicate').evaluate(e=>e.remove());
        const click=async()=>{const e=(await read()).elements.find(e=>e.name==='Save');assert.ok(e);const point={button:'left',x:e.x+Math.floor(e.width/2),y:e.y+Math.floor(e.height/2)};await dispatchOperation(s,'input.click',point);await page.evaluate(()=>{document.title='repeat';});await dispatchOperation(s,'input.click',point);assert.equal(await page.title(),'saved','click at unchanged pointer');};await click();
        const moved=spawnSync('xdotool',['getactivewindow','windowmove','61','37'],{env:s.env,encoding:'utf8',timeout:3000});assert.equal(moved.status,0);await pause(300);await page.evaluate(()=>{document.title='moved';});await click();
        await page.evaluate(()=>window.scrollTo(0,1900));await pause(200);assert.equal((await verify('control_present','Far below')).status,'pass');assert.equal((await verify('control_present','Save')).status,'fail');
        console.log(JSON.stringify({listed:first.elements.length}));
      }finally{await s.close();}`;
    const result = JSON.parse(admin("exec", ["node", "--input-type=module", "-e", code]));
    assert.equal(result.listed, 2);
    summary.checks.push("consecutive_page_verify_pass_fail_duplicate_unknown", "sensitive_covered_offscreen_iframe_exclusions", "focused_control_without_values", "calibrated_clicks_after_window_move_and_scroll");
    summary.outcome = "passed";
  } finally {
    try {
      // Refuse cleanup of any resource not owned by this exact disposable project.
      for (const kind of ["container", "volume"]) {
        const ids = run(kind === "container" ? ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`] : ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]).split(/\r?\n/).filter(Boolean);
        for (const id of ids) {
          const [value] = JSON.parse(run([kind, "inspect", id]));
          assert.equal((kind === "container" ? value.Config.Labels : value.Labels)["com.docker.compose.project"], project);
          if (kind === "volume") { assert.equal(value.Driver, "local"); assert.equal(Object.keys(value.Options ?? {}).length, 0); }
        }
      }
      compose(["down", "--volumes", "--remove-orphans"]);
      if (built) {
        const tag = `${project}-desktop:latest`, [image] = JSON.parse(run(["image", "inspect", tag]));
        assert.equal(image.Config.Labels["ai.eclipse.task028.run"], project);
        run(["image", "rm", tag]);
      }
      summary.cleanup = "complete";
    } catch { summary.cleanup = "refused"; summary.outcome = "incomplete"; }
    await writeFile(path.join(evidence.directory, "result.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`TASK-028 desktop evidence: data/spikes/task-028/${evidence.runId}/result.json`);
    assert.equal(summary.cleanup, "complete");
  }
});
