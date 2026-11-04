import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { PassThrough, Readable } from "node:stream";
import { parseCommand, OperationSchema, TakeoverSchema, OwnerInputSchema, WorkerOperationSchema, StreamSchema, resultFor, validatePng, validKey, LIFECYCLE_OPERATIONS } from "../docker/desktop/controller-schema.mjs";
import { MAX_MESSAGE_BYTES, writeFramed, readFramed, createChannel } from "../docker/desktop/controller-channel.mjs";
import { createController } from "../docker/desktop/controller.mjs";
import { SessionManager } from "../docker/desktop/session-manager.mjs";

const OWNER = randomUUID(), AGENT = randomUUID(), GENERATION = randomUUID(), SECRET = "a".repeat(64);
const base = () => ({ ownerId: OWNER, agentId: AGENT, requestId: randomUUID() });
const running = () => ({ ...base(), generation: GENERATION });
const control = () => ({ ...running(), sessionRef: "b".repeat(64), connectionId: randomUUID() });
const loopback = async () => [{ address: "127.0.0.1", family: 4 }];
const tick = () => new Promise(setImmediate);
function frame(value) { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); }
async function collect(stream) { const values = []; for await (const value of readFramed(stream)) values.push(value); return values; }

test("schema validates operation-specific UUID generations, arguments, key chords and bounded desktop geometry", () => {
  const operations = [
    { operation: "capture.screenshot", crop: { x: 10, y: 20, width: 100, height: 200 } },
    { operation: "input.click", button: "double", x: 1023, y: 767 },
    { operation: "input.type", text: "Ordinary Unicode é" },
    { operation: "input.key", key: "Control+Shift+ArrowLeft" },
    { operation: "input.scroll", direction: "up", count: 20 },
    { operation: "browser.pages" },
    { operation: "page.snapshot" }, { operation: "page.snapshot", pageId: randomUUID() },
    { operation: "browser.locator", selector: "input", action: "fill", text: "hello", pageId: randomUUID() },
  ];
  for (const operation of operations) assert.equal(parseCommand({ ...running(), ...operation }).operation, operation.operation);
  for (const operation of ["session.start", "session.status", "session.stop"]) assert.equal(parseCommand({ ...base(), operation }).operation, operation);
  for (const invalid of [
    { operation: "capture.screenshot", generation: 0 }, { operation: "capture.screenshot", generation: undefined },
    { operation: "capture.screenshot", crop: { x: 1000, y: 0, width: 100, height: 1 } },
    { operation: "input.click", button: "left", x: 1024, y: 0 }, { operation: "input.click", button: "left", x: 0, y: 768 },
    { operation: "input.type", text: "x".repeat(4097) }, { operation: "input.type", text: "bad\u0000control" },
    { operation: "input.key", key: "Control+Control+a" }, { operation: "input.key", key: "arbitrary-command" },
    { operation: "input.scroll", direction: "up", count: 21 }, { operation: "browser.locator", selector: "input", action: "fill" },
    { operation: "exec.shell", command: "anything" }, { operation: "browser.pages", evaluate: "arbitrary" },
    { operation: "page.snapshot", selector: "input" }, { operation: "page.snapshot", pageId: "not-a-uuid" }, { operation: "page.snapshot", script: "document.cookie" },
  ]) assert.throws(() => parseCommand({ ...running(), ...invalid }));
  for (const key of ["Enter", "Tab", "Control+c", "Meta+l", "Control+Alt+Delete", "Shift+F12"]) assert.equal(validKey(key), true);
});
test("schema rejects control metadata at worker boundary and requires complete scoped stream/takeover input", () => {
  for (const extra of [{ ownerId: OWNER }, { agentId: AGENT }, { generation: GENERATION }, { requestId: randomUUID() }, { sessionRef: "b".repeat(64) }])
    assert.equal(OperationSchema.safeParse({ operation: "browser.pages", ...extra }).success, false);
  const c = control();
  assert.equal(TakeoverSchema.safeParse({ ...c, operation: "takeover" }).success, true);
  assert.equal(OwnerInputSchema.safeParse({ ...c, operation: "input.type", text: "hello", leaseId: randomUUID() }).success, true);
  assert.equal(OwnerInputSchema.safeParse({ ...c, operation: "input.type", text: "hello", leaseId: randomUUID(), ownerInput: true }).success, false);
  const workerFrame = { command: "operation", requestId: randomUUID(), operation: "input.type", params: { operation: "input.type", text: "hello" } };
  assert.equal(WorkerOperationSchema.safeParse(workerFrame).success, true);
  assert.equal(WorkerOperationSchema.safeParse({ ...workerFrame, ownerInput: true }).success, true);
  assert.equal(WorkerOperationSchema.safeParse({ ...workerFrame, ownerInput: false }).success, false);
  assert.equal(WorkerOperationSchema.safeParse({ ...workerFrame, extra: true }).success, false);
  const { ownerId, generation, sessionRef, connectionId } = c;
  assert.equal(StreamSchema.safeParse({ ownerId, generation, sessionRef, connectionId }).success, true);
  assert.equal(StreamSchema.safeParse({ ownerId, generation, sessionRef, connectionId, url: "http://127.0.0.1" }).success, false);
  assert.equal(TakeoverSchema.safeParse({ ...c, operation: "handback" }).success, false);
});
test("operation results reject mismatched types, untagged data and invalid PNG dimensions", () => {
  assert.deepEqual(resultFor("input.click", { ok: true }), { ok: true });
  assert.throws(() => resultFor("input.click", { width: 1, height: 1 }));
  assert.throws(() => resultFor("browser.pages", []));
  assert.throws(() => resultFor("browser.pages", { pages: [] }));
  assert.deepEqual(resultFor("browser.pages", { pages: [], source_tag: "tool", untrusted: true }), { pages: [], source_tag: "tool", untrusted: true });
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write("IHDR",12); png.writeUInt32BE(1024,16); png.writeUInt32BE(768,20);
  assert.deepEqual(validatePng(png, { width:1024,height:768 }), { width:1024,height:768 });
  assert.throws(() => validatePng(png, { width:10,height:10 }));
  assert.throws(() => validatePng(Buffer.alloc(20)));
  assert.throws(() => resultFor("capture.screenshot", { width:1024,height:768,base64:png.toString("base64"),source_tag:"tool",untrusted:true }, { crop:{width:100,height:100} }));
});
test("page snapshot results are strict, tagged, bounded and carry no field values", () => {
  const good = { pageId: randomUUID(), href: "https://a.example/", title: "T", frames: 0, paymentFrames: 0, source_tag: "tool", untrusted: true,
    elements: [{ ref: 1, role: "button", name: "Save", tag: "button", frame: "top", shadow: false, x: 10, y: 20, width: 50, height: 30 }] };
  assert.deepEqual(resultFor("page.snapshot", good), good);
  const bad = (patch) => () => resultFor("page.snapshot", { ...good, ...patch });
  assert.throws(bad({ untrusted: false })); assert.throws(bad({ source_tag: "user" })); assert.throws(bad({ frames: 65 }));
  assert.throws(bad({ elements: Array(151).fill(good.elements[0]) }));
  for (const patch of [{ name: "x".repeat(81) }, { name: "a\u0007b" }, { x: 1000 }, { y: 760 }, { width: 0 }, { x: 1.5 }, { value: "secret" }, { role: "Button" },
    { frame: "middle" }, { shadow: "yes" }])
    assert.throws(bad({ elements: [{ ...good.elements[0], ...patch }] }), JSON.stringify(patch));
  assert.throws(bad({ paymentFrames: 65 }));
});
test("TASK-084: select, navigate and find_text are strict, and find_text returns only a count", () => {
  for (const operation of [
    { operation: "input.select", x: 10, y: 20, option: "Germany" },
    { operation: "browser.navigate", url: "https://a.example/settings" },
    { operation: "page.find_text", text: "Hello\nworld" },
  ]) assert.equal(parseCommand({ ...running(), ...operation }).operation, operation.operation);
  for (const invalid of [
    { operation: "input.select", x: 1024, y: 0, option: "x" }, { operation: "input.select", x: 0, y: 768, option: "x" },
    { operation: "input.select", x: 0, y: 0, option: "" }, { operation: "input.select", x: 0, y: 0, option: "x".repeat(201) },
    { operation: "input.select", x: 0, y: 0, option: "x\u0000" }, { operation: "input.select", x: 0, y: 0, option: "x", top: 1 },
    { operation: "browser.navigate", url: "javascript:alert(1)" }, { operation: "browser.navigate", url: "file:///etc/passwd" },
    { operation: "browser.navigate", url: "data:text/html,x" }, { operation: "browser.navigate", url: "https://u:p@a.example/" },
    { operation: "browser.navigate", url: "https://a.example/", pageId: randomUUID() }, { operation: "browser.navigate", url: "https://a.example/" + "x".repeat(2048) },
    { operation: "page.find_text", text: "" }, { operation: "page.find_text", text: "x".repeat(2001) },
    { operation: "page.find_text", text: "bad\u0000text" }, { operation: "page.find_text", text: "hello", pageId: "not-a-uuid" },
  ]) assert.throws(() => parseCommand({ ...running(), ...invalid }), JSON.stringify(invalid).slice(0, 90));
  const found = { found: true, count: 2, source_tag: "tool", untrusted: true };
  assert.deepEqual(resultFor("page.find_text", found), found);
  assert.throws(() => resultFor("page.find_text", { ...found, text: "Hello" }), "only a count crosses the boundary");
  assert.throws(() => resultFor("page.find_text", { ...found, count: 1001 }));
  assert.throws(() => resultFor("page.find_text", { ...found, untrusted: false }));
});
test("framing reads fragmented/coalesced messages and rejects truncated/invalid/oversized frames", async () => {
  const packed = Buffer.concat([frame({ a:1 }),frame({ b:2 })]);
  assert.deepEqual(await collect(Readable.from([...packed].map((byte) => Buffer.from([byte])))), [{a:1},{b:2}]);
  assert.deepEqual(await collect(Readable.from([packed])), [{a:1},{b:2}]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_MESSAGE_BYTES+1);
  await assert.rejects(collect(Readable.from([oversized])), /message_too_large/);
  await assert.rejects(collect(Readable.from([Buffer.alloc(4)])), /message_too_large/);
  await assert.rejects(collect(Readable.from([packed.subarray(0,6)])), /truncated_frame/);
  await assert.rejects(writeFramed(new PassThrough(), {data:"x".repeat(MAX_MESSAGE_BYTES)}), /message_too_large/);
  const pass = new PassThrough(); const reading=collect(pass); await writeFramed(pass,{roundTrip:true}); pass.end(); assert.deepEqual(await reading,[{roundTrip:true}]);
});
test("channel correlates responses, caps pending requests, rejects duplicate IDs and ignores late replies", async () => {
  const readable = new PassThrough(), writable = new PassThrough();
  const channel = createChannel(readable,writable,{maxPending:2});
  const firstId=randomUUID(), secondId=randomUUID();
  try {
    const first=channel.send({requestId:firstId},{timeoutMs:50});
    const firstDenied=assert.rejects(first,{code:"uncertain_outcome"});
    const second=channel.send({requestId:secondId},{timeoutMs:2000});
    await assert.rejects(channel.send({requestId:secondId}),{code:"channel_busy"});
    await assert.rejects(channel.send({requestId:randomUUID()}),{code:"channel_busy"});
    await firstDenied;
    await writeFramed(readable,{requestId:firstId,result:{late:true}});
    let resolved=false; void second.then(()=>{resolved=true;}); await tick(); assert.equal(resolved,false);
    await writeFramed(readable,{requestId:secondId,result:{ok:true}}); assert.deepEqual(await second,{ok:true});
    const thirdId=randomUUID(), third=channel.send({requestId:thirdId});
    await writeFramed(readable,{requestId:thirdId,error:{code:"SYNTHETIC_CANARY_SECRET"}});
    await assert.rejects(third,(error)=>error.code==="operation_failed"&&!error.message.includes("CANARY"));
  } finally { channel.close(); readable.end();writable.end();await channel.done; }
});
test("channel closure rejects pending work and malformed frames terminate the channel", async () => {
  for (const invalid of [null, [], {bad:true}]) {
    const readable=new PassThrough(),writable=new PassThrough(),channel=createChannel(readable,writable);
    const pending=channel.send({requestId:randomUUID()}); const denied=assert.rejects(pending,{code:"channel_closed"});
    await writeFramed(readable,invalid); await denied;
    await assert.rejects(channel.send({requestId:randomUUID()}),{code:"channel_closed"});
    readable.end();writable.end();await channel.done;
  }
});
function request(server,{method="POST",path=`/v1/agents/${AGENT}/commands`,headers={},body={...base(),operation:"session.status"}}={}) {
  return new Promise((resolve,reject)=>{
    const encoded=typeof body==="string"?body:JSON.stringify(body);
    const req=http.request({host:"127.0.0.1",port:server.address().port,path,method,agent:false,headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(encoded),Authorization:`Bearer ${SECRET}`,...headers}},res=>{
      const chunks=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>{try{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,text,body:JSON.parse(text)});}catch(error){reject(error);}});
    });req.on("error",reject);req.end(encoded);
  });
}
async function withController(run,{manager,resolveApp=loopback}={}) {
  const calls=[];
  const chosen=manager??{async status(ownerId,agentId){calls.push({ownerId,agentId});return{agentId,state:"running",generation:GENERATION};}};
  const server=createController(chosen,SECRET,{resolveApp});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {await run(server,calls);}finally{server.closeControllerStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test("HTTP controller accepts only exact app peer plus service secret; spoofed forwarding cannot bypass source", async () => {
  await withController(async(server,calls)=>{
    assert.equal((await request(server)).status,200);assert.equal(calls.length,1);
    for(const Authorization of ["",`Bearer ${"b".repeat(64)}`,"Bearer bad",`bearer ${SECRET}`,`Bearer ${SECRET}x`]) {
      const response=await request(server,{headers:{Authorization}});assert.equal(response.status,401);assert.equal(response.body.code,"auth_failed");
    }
    for(const Origin of ["http://127.0.0.1", "null"]) {
      const response=await request(server,{headers:{Origin}});assert.equal(response.status,403);assert.equal(response.body.code,"source_denied");
    }
    assert.equal(calls.length,1);
  });
  for(const resolveApp of [async()=>[{address:"198.51.100.2"}],async()=>{throw Error("synthetic DNS failure");},async()=>[]])
    await withController(async(server,calls)=>{
      const response=await request(server,{headers:{"X-Forwarded-For":"198.51.100.2","X-Real-IP":"198.51.100.2"}});
      assert.equal(response.status,403);assert.equal(response.body.code,"source_denied");assert.equal(calls.length,0);
    },{resolveApp});
});
test("authenticated controller validates method/path/content/body before dispatch and never exposes raw errors", async () => {
  await withController(async(server,calls)=>{
    for(const [options,status,code] of [
      [{method:"GET"},405,"method_not_allowed"], [{path:"/v1/wrong"},404,"not_found"],
      [{headers:{"Content-Type":"text/plain"}},415,"invalid_content_type"], [{body:"{"},400,"invalid_json"],
      [{body:"x".repeat(17000),headers:{"Content-Length":"17000"}},413,"body_too_large"],
      [{body:{...base(),operation:"session.status",extra:true}},400,"invalid_command"],
      [{body:{...base(),agentId:randomUUID(),operation:"session.status"}},400,"invalid_command"],
      [{body:{...base(),operation:"session.status",generation:0}},400,"invalid_command"],
      [{path:`/v1/agents/${AGENT}/commands?url=http://127.0.0.1`},404,"not_found"],
    ]){const response=await request(server,options);assert.equal(response.status,status);assert.equal(response.body.code,code);}
    assert.equal(calls.length,0);
  });
  await withController(async(server)=>{const response=await request(server);assert.equal(response.status,409);assert.equal(response.body.code,"operation_failed");assert.doesNotMatch(response.text,/CANARY|private\/path/);},
    {manager:{async status(){throw Error("SYNTHETIC_CANARY private/path");}}});
});
test("authenticated controller dispatches scoped agent create/delete without exposing identity fields", async () => {
  const calls=[];
  const manager={
    async create(ownerId,agentId){calls.push({operation:"create",ownerId,agentId});return{agentId,state:"ready",uid:20000,home:"/workspace/homes/private"};},
    async delete(ownerId,agentId){calls.push({operation:"delete",ownerId,agentId});return{agentId};},
  };
  await withController(async(server)=>{
    for(const operation of ["agent.create","agent.delete"]){
      const response=await request(server,{body:{...base(),operation}});
      assert.equal(response.status,200);assert.deepEqual(response.body,{outcome:"ok",result:{agentId:AGENT,...(operation==="agent.create"?{state:"ready"}:{})}});
      assert.doesNotMatch(response.text,/uid|workspace|home/i);
    }
    assert.deepEqual(calls.map(({operation,ownerId,agentId})=>({operation,ownerId,agentId})),[
      {operation:"create",ownerId:OWNER,agentId:AGENT},
      {operation:"delete",ownerId:OWNER,agentId:AGENT},
    ]);
    for(const operation of ["agent.create","agent.delete"]){
      const wrongAgent=await request(server,{body:{...base(),agentId:randomUUID(),operation}});assert.equal(wrongAgent.status,400);
      const forgedPath=await request(server,{body:{...base(),operation,path:"/workspace/homes/forged"}});assert.equal(forgedPath.status,400);
    }
    assert.equal(calls.length,2);
  },{manager});
});
test("authenticated controller dispatches lifecycle operations with the scoped owner, agent and generation", async () => {
  const calls = [];
  const result = (agentId) => ({ agentId, state: "running", sandbox: "running", graphics: "running", browser: "running", generation: GENERATION });
  const manager = {
    async ensureSandbox(ownerId, agentId) { calls.push({ operation: "sandbox.start", ownerId, agentId, generation: undefined }); return result(agentId); },
    async startDesktop(ownerId, agentId, generation) { calls.push({ operation: "desktop.start", ownerId, agentId, generation }); return result(agentId); },
    async stopDesktop(ownerId, agentId, generation) { calls.push({ operation: "desktop.stop", ownerId, agentId, generation }); return result(agentId); },
    async startBrowser(ownerId, agentId, generation) { calls.push({ operation: "browser.start", ownerId, agentId, generation }); return result(agentId); },
    async stopBrowser(ownerId, agentId, generation) { calls.push({ operation: "browser.stop", ownerId, agentId, generation }); return result(agentId); },
  };
  await withController(async (server) => {
    const operations = [...LIFECYCLE_OPERATIONS, "desktop.start", "browser.stop"];
    for (const operation of operations) {
      const body = { ...base(), operation, ...(operation === "sandbox.start" ? {} : { generation: GENERATION }) };
      const response = await request(server, { body });
      assert.equal(response.status, 200, `${operation}: ${response.text}`);
      assert.equal(response.body.outcome, "ok");
      assert.equal(response.body.result.agentId, AGENT);
    }
    assert.deepEqual(calls.map(({ operation, ownerId, agentId }) => ({ operation, ownerId, agentId })), operations.map((operation) => ({ operation, ownerId: OWNER, agentId: AGENT })));
    assert.ok(calls.filter((call) => call.operation !== "sandbox.start").every((call) => call.generation === GENERATION));
  }, { manager });
});

test("HTTP dispatch preserves owner/generation/lease checks through the actual manager", async () => {  const manager=new SessionManager(),calls=[];
  manager.entries.set(AGENT,{record:{ownerId:OWNER,agentId:AGENT,uid:20000},state:"running",generation:GENERATION,channel:{async send(message){calls.push(message);return{ok:true};}}});
  await withController(async(server)=>{
    const body={...running(),operation:"input.click",button:"left",x:1,y:2};
    assert.equal((await request(server,{body})).status,200);assert.equal(calls.length,1);
    for(const [extra,status,code] of [[{ownerId:randomUUID()},404,"agent_unavailable"],[{generation:randomUUID()},409,"stale_generation"],[{sessionRef:"b".repeat(64)},400,"invalid_command"]]){
      const response=await request(server,{body:{...body,requestId:randomUUID(),...extra}});assert.equal(response.status,status);assert.equal(response.body.code,code);
    }
    assert.equal(calls.length,1);assert.deepEqual(calls[0].params,{operation:"input.click",button:"left",x:1,y:2});
  },{manager});
});
function upgrade(server,path,headers={}) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:"127.0.0.1",port:server.address().port});let output="",done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(output);};
    const timer=setTimeout(()=>{socket.destroy();reject(Error("upgrade test timeout"));},2000);
    socket.once("connect",()=>socket.write(`GET ${path} HTTP/1.1\r\nHost: desktop\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers).map(([key,value])=>`${key}: ${value}\r\n`).join("")}\r\n`));
    socket.on("data",chunk=>{output+=chunk.toString();if(output.includes("\r\n\r\n"))finish();});socket.once("end",finish);socket.once("close",finish);socket.once("error",finish);
  });
}
test("WebSocket upgrades require service secret and exact source before any stream lookup", async () => {
  for(const resolveApp of [loopback,async()=>[{address:"172.20.0.2"}],async()=>{throw Error("DNS unavailable");}]){
    let lookups=0;
    const manager={streamInfo(){lookups++;throw Error("must not reach");}};
    await withController(async(server)=>{
      const c=control(),{ownerId,generation,sessionRef,connectionId}=c;
      const path=`/v1/agents/${AGENT}/stream?${new URLSearchParams({ownerId,generation,sessionRef,connectionId})}`;
      for(const headers of [{},{Authorization:`Bearer ${"b".repeat(64)}`},{Authorization:`Bearer ${SECRET}`,Origin:"http://127.0.0.1"}]){
        const response=await upgrade(server,path,headers);assert.doesNotMatch(response,/101 Switching/);assert.match(response,/HTTP\/1\.1 (401|403) /);
      }
      if(resolveApp!==loopback){const response=await upgrade(server,path,{Authorization:`Bearer ${SECRET}`,"X-Forwarded-For":"172.20.0.2"});assert.match(response,/HTTP\/1\.1 403 /);}
      assert.equal(lookups,0);
    },{manager,resolveApp});
  }
});
test("authenticated WS rejects wrong owner/stale generation/unknown agent/query injection and only then registers a viewer", async () => {
  const manager=new SessionManager();let lookups=0;
  const sockets=new Set(),vnc=net.createServer(socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));socket.end();});
  await new Promise(resolve=>vnc.listen(0,"127.0.0.1",resolve));
  manager.entries.set(AGENT,{record:{ownerId:OWNER,agentId:AGENT,uid:20000},state:"running",graphics:"running",generation:GENERATION,vncReady:true,vncPassword:"SyntheT+",vncPort:vnc.address().port});
  const original=manager.streamInfo.bind(manager);manager.streamInfo=(...args)=>{lookups++;return original(...args);};
  try{await withController(async(server)=>{
    const {ownerId,generation,sessionRef,connectionId}=control();const query={ownerId,generation,sessionRef,connectionId};
    for(const [agentId,extra] of [[AGENT,{ownerId:randomUUID()}],[AGENT,{generation:randomUUID()}],[randomUUID(),{}],[AGENT,{url:"http://127.0.0.1:9"}]]){
      const response=await upgrade(server,`/v1/agents/${agentId}/stream?${new URLSearchParams({...query,...extra})}`,{Authorization:`Bearer ${SECRET}`});assert.doesNotMatch(response,/101 Switching/);
    }
    const duplicate=await upgrade(server,`/v1/agents/${AGENT}/stream?${new URLSearchParams(query)}&ownerId=${OWNER}`,{Authorization:`Bearer ${SECRET}`});assert.doesNotMatch(duplicate,/101 Switching/);
    assert.equal(manager.viewers.size,0);
    const accepted=await upgrade(server,`/v1/agents/${AGENT}/stream?${new URLSearchParams(query)}`,{Authorization:`Bearer ${SECRET}`});assert.match(accepted,/HTTP\/1\.1 101 Switching Protocols/);
    await tick();assert.ok(lookups>=4);
  },{manager});}finally{manager.closeViewers(AGENT);for(const socket of sockets)socket.destroy();await new Promise(resolve=>vnc.close(resolve));}
});
