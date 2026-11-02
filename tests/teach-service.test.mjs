import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runProcess, minimalEnvironment } from "../scripts/spikes/volume-isolation.mjs";

test("private Postgres migration, teach service persistence, owner routes and append-only audio ledger", { timeout: 180000 }, async () => {
  const run = randomBytes(8).toString("hex"); const prefix = `eclipseteachdb${run}`;
  const network = `${prefix}-net`, postgres = `${prefix}-postgres`, node = `${prefix}-node`;
  const label = `ai.eclipse.teachdb.run=${run}`; const directory = path.resolve("data/spikes/task036-service", run);
  await mkdir(directory, { recursive: true });
  const report = { run, outcome: "incomplete", cleanup: "incomplete" };
  const created = [];
  const docker = async (args, input, timeout = 30000) => {
    const value = await runProcess("docker", args, { input, timeout, env: minimalEnvironment() });
    assert.ok(!value.timedOut && !value.oversized); assert.equal(value.status, 0, value.output.slice(-2500)); return value.output.trim();
  };
  try {
    await docker(["network", "create", "--internal", "--label", label, network]); created.push(["network", network]);
    await docker(["run", "-d", "--name", postgres, "--label", label, "--network", network,
      "-e", "POSTGRES_USER=eclipse_bootstrap", "-e", "POSTGRES_DB=eclipse", "-e", "POSTGRES_PASSWORD=task036-bootstrap-fixture",
      "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"]); created.push(["container", postgres]);
    await docker(["run", "-d", "--name", node, "--label", label, "--network", network, "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--user", "1000:1000", "--tmpfs", "/tmp:uid=1000,gid=1000,mode=1777,size=268435456",
      "-e", `DATABASE_URL=postgresql://eclipse_app:task036-app-fixture@${postgres}:5432/eclipse`,
      "-e", `QA_ADMIN=postgresql://eclipse_bootstrap:task036-bootstrap-fixture@${postgres}:5432/eclipse`,
      "-e", "APP_ORIGIN=http://127.0.0.1:3000", "-e", "ARTIFACTS_DIR=/tmp/qa/artifacts", "main-app", "sleep", "infinity"]); created.push(["container", node]);
    await docker(["exec", node, "node", "-e", "require('fs').mkdirSync('/tmp/qa',{recursive:true});require('fs').symlinkSync('/app/node_modules','/tmp/qa/node_modules');"]);
    const sources = [];
    const collect = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else if (entry.isFile()) sources.push([file.split(path.sep).join("/"), (await readFile(file)).toString("base64")]);
      }
    };
    for (const source of ["lib", "db", "drizzle", "app"]) await collect(source);
    for (const file of ["tsconfig.json", "package.json"]) sources.push([file, (await readFile(file)).toString("base64")]);
    // Docker's archive-copy endpoint cannot see this engine's tmpfs overlay;
    // stream only explicit source files through the already-running node user.
    await docker(["exec", "-i", node, "node", "-e", "const fs=require('node:fs'),path=require('node:path');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{for(const [name,body] of JSON.parse(text)){if(!/^[a-zA-Z0-9_./\\[\\]-]+$/.test(name)||name.split('/').includes('..'))throw Error('invalid_source');const file=path.join('/tmp/qa',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(body,'base64'));}console.log('source-installed')});"], JSON.stringify(sources));
    const code = `
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
const load=async file=>{const m=await import(file);return m.default??m};
let stage='database';
try {
 const admin=new pg.Pool({connectionString:process.env.QA_ADMIN});
 for(let i=0;i<40;i++){try{await admin.query('select 1');break;}catch(error){if(i===39)throw error;await new Promise(r=>setTimeout(r,250));}}
 await admin.query("CREATE ROLE eclipse_app LOGIN PASSWORD 'task036-app-fixture'; REVOKE CREATE ON SCHEMA public FROM PUBLIC;");
 const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8'));
 for(const entry of journal.entries)await admin.query((await readFile('drizzle/'+entry.tag+'.sql','utf8')).replaceAll('--> statement-breakpoint',''));
 await admin.query("CREATE SCHEMA drizzle; REVOKE ALL ON SCHEMA drizzle FROM PUBLIC,eclipse_app; REVOKE CREATE,TEMP ON DATABASE eclipse FROM PUBLIC,eclipse_app; GRANT USAGE ON SCHEMA public TO eclipse_app; GRANT SELECT,INSERT,UPDATE ON owner,agents,agent_policies,model_roles,model_prices,runs,teach_recordings TO eclipse_app; GRANT SELECT,INSERT,UPDATE,DELETE ON sessions,providers TO eclipse_app; GRANT SELECT,INSERT ON chat_sessions,messages,steps,step_evidence,checkpoints,cost_entries TO eclipse_app;");
 const owner='03600000-0000-4000-8000-000000000001', agent='03600000-0000-4000-8000-000000000002', provider='03600000-0000-4000-8000-000000000003';
 await admin.query("INSERT INTO owner(id,owner_id,login,password_hash,timezone) VALUES($1,$1,'owner','hash','UTC')",[owner]);
 await admin.query("INSERT INTO agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) VALUES($1,$2,'Demo','Demo','demo','active',100,1000)",[agent,owner]);
 await admin.query("INSERT INTO agent_policies(agent_id,owner_id) VALUES($1,$2)",[agent,owner]);
 await admin.query("INSERT INTO providers(id,owner_id,kind) VALUES($1,$2,'meta')",[provider,owner]);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema=await load('./db/schema.ts');const database=drizzle({client:pool,schema});
 await mkdir(process.env.ARTIFACTS_DIR,{recursive:true,mode:0o700});
 const service=await load('./lib/teach/service.ts');const storage=await load('./lib/teach/store.ts');
 const session={ownerId:owner,sessionId:randomUUID(),sessionRef:'a'.repeat(64),csrfToken:'b'.repeat(64)};
 const lease={generation:randomUUID(),connectionId:randomUUID(),leaseId:randomUUID()};
 const video=Buffer.from('1a45dfa300010203','hex'), hash=createHash('sha256').update(video).digest('hex');
 let id;const seen=[];
 const desktop=async(a,o,s,b)=>{assert.equal(a,agent);assert.equal(o,owner);assert.equal(s,session.sessionRef);seen.push(b.action);
  if(b.action==='start'){id=b.captureId;return {captureId:id,state:'recording',activeMs:0,eventCount:0,narration:false};}
  assert.equal(b.captureId,id);
  if(b.action==='artifact')return {captureId:id,state:'complete',activeMs:1000,eventCount:0,narration:false,base64:video.toString('base64')};
  if(b.action==='stop')return {captureId:id,state:'complete',activeMs:1000,eventCount:0,narration:false,manifest:{version:1,captureId:id,capturedAt:new Date().toISOString(),timezone:'UTC',durationMs:1000,videoHash:hash,events:[],audio:[],source_tag:'web',untrusted:true},artifacts:[{hash,mime:'video/webm',kind:'video',bytes:video.length}]};
  return {captureId:id,state:b.action==='discard'?'discarded':b.action==='pause'?'paused':'recording',...(b.action==='pause'?{reason:'sensitive_surface'}:{}),activeMs:0,eventCount:0,narration:false};};
 stage='capture';
 const started=await service.controlCapture(database,session,agent,{...lease,action:'start',narration:false},desktop);assert.equal(started.state,'recording');
 await assert.rejects(()=>storage.ownedCapture(database,randomUUID(),id),error=>error.status===404);
 const paused=await service.controlCapture(database,session,agent,{...lease,action:'pause',captureId:id},desktop);assert.equal(paused.state,'paused');
 assert.equal((await admin.query("SELECT count(*)::int n FROM messages WHERE card_type='teach_paused'")).rows[0].n,1);
 await service.controlCapture(database,session,agent,{...lease,action:'resume',captureId:id},desktop);
 const stopped=await service.controlCapture(database,session,agent,{...lease,action:'stop',captureId:id},desktop);assert.equal(stopped.state,'complete');
 assert.deepEqual(await storage.getCaptureArtifact(owner,id,hash),video);
 assert.deepEqual((await service.listCaptures(database,owner,agent)).map(c=>c.captureId),[id]);
 assert.deepEqual(await service.listCaptures(database,randomUUID(),agent),[]);
 const replay=await service.controlCapture(database,session,agent,{...lease,action:'stop',captureId:id},desktop);assert.equal(replay.state,'complete');assert.equal(seen.filter(a=>a==='stop').length,1);
 stage='authenticated-routes';
 const token='c'.repeat(64),csrf='d'.repeat(64),sid=randomUUID();
 await admin.query("INSERT INTO sessions(id,owner_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[sid,owner,createHash('sha256').update(token).digest('hex'),csrf]);
 const headers={Cookie:'eclipse_session='+token,Origin:process.env.APP_ORIGIN,'Content-Type':'application/json','x-csrf-token':csrf};
 const captureRoute=await load('./app/api/teach/[captureId]/route.ts'),artifactRoute=await load('./app/api/teach/[captureId]/artifact/route.ts'),teachRoute=await load('./app/api/desktop/[agentId]/teach/route.ts');
 const params={params:Promise.resolve({captureId:id})};
 assert.equal((await captureRoute.GET(new Request(process.env.APP_ORIGIN+'/api/teach/'+id,{headers}),params)).status,200);
 const media=await artifactRoute.GET(new Request(process.env.APP_ORIGIN+'/api/teach/'+id+'/artifact?hash='+hash,{headers}),params);assert.equal(media.status,200);assert.deepEqual(Buffer.from(await media.arrayBuffer()),video);
 assert.equal((await artifactRoute.GET(new Request(process.env.APP_ORIGIN+'/api/teach/'+id+'/artifact?hash='+'0'.repeat(64),{headers}),params)).status,404);
 const noCsrf={...headers,'x-csrf-token':'0'.repeat(64)};
 assert.equal((await teachRoute.POST(new Request(process.env.APP_ORIGIN+'/api/desktop/'+agent+'/teach',{method:'POST',headers:noCsrf,body:'{}'}),{params:Promise.resolve({agentId:agent})})).status,403);
 const listed=await teachRoute.GET(new Request(process.env.APP_ORIGIN+'/api/desktop/'+agent+'/teach',{headers}),{params:Promise.resolve({agentId:agent})});assert.equal(listed.status,200);
 const listedBody=await listed.json();assert.deepEqual(listedBody.captures.map(c=>c.captureId),[id]);assert.equal(listedBody.narrationAllowed,false);
 stage='ledger';
 await pool.query("INSERT INTO cost_entries(id,owner_id,agent_id,provider_id,capture_id,call_index,model,tokens_in,tokens_out,tokens_cached,cost_micro_usd,outcome,idempotency_key,audio_duration_ms) VALUES($1,$2,$3,$4,$5,1,'muse-voice-transcribe-1.0',0,0,0,100,'asr_complete',$6,2000)",[randomUUID(),owner,agent,provider,id,'teach:'+id+':asr:0']);
 await assert.rejects(()=>pool.query('UPDATE cost_entries SET cost_micro_usd=0'));
 await assert.rejects(()=>pool.query('DELETE FROM cost_entries'));
 await service.controlCapture(database,session,agent,{...lease,action:'discard',captureId:id},desktop);
 assert.equal((await admin.query('SELECT state FROM teach_recordings WHERE id=$1',[id])).rows[0].state,'discarded');assert.equal(await storage.getCaptureArtifact(owner,id,hash),null);
 assert.deepEqual(await service.listCaptures(database,owner,agent),[]);
 assert.equal((await admin.query('SELECT count(*)::int n FROM cost_entries WHERE capture_id=$1',[id])).rows[0].n,1);
 console.log(JSON.stringify({passed:true,migrations:journal.entries.length,capturePersistence:true,ownerRoutes:true,crossOwnerDenied:true,pauseCard:true,idempotentStop:true,appendOnlyLedger:true,discardNamespace:true}));
 await pool.end();await admin.end();process.exit(0);
}catch(error){console.log(JSON.stringify({passed:false,stage,message:error.message?.slice(0,160),stack:error.stack?.split('\\n').slice(0,3)}));process.exit(1);}
`;
    const output = await docker(["exec", "-i", "--workdir", "/tmp/qa", node, "node", "--conditions=react-server", "--import", "tsx", "--input-type=module", "-"], code, 90000);
    report.result = JSON.parse(output.split(/\r?\n/).findLast((line) => line.startsWith('{"passed"'))); assert.equal(report.result.passed, true); report.outcome = "passed";
  } finally {
    for (const [kind, name] of created.reverse()) {
      const [value] = JSON.parse(await docker([...(kind === "container" ? [] : [kind]), "inspect", name]));
      assert.equal((value.Config?.Labels ?? value.Labels)["ai.eclipse.teachdb.run"], run);
      await docker(kind === "container" ? ["rm", "-f", "-v", name] : ["network", "rm", name]);
    }
    for (const args of [["ps", "-aq"], ["network", "ls", "-q"]]) assert.equal(await docker([...args, "--filter", `label=${label}`]), "");
    report.cleanup = "complete"; await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Teach service evidence: ${directory}`);
  }
});
