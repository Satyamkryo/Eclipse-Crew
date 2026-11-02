import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { TeachCapture } from '../docker/desktop/teach-capture.mjs';
import { safeEvent, sanitizedFrame, MASK_SELECTOR } from '../docker/desktop/teach-safety.mjs';
import { TeachSchema } from '../docker/desktop/controller-schema.mjs';
import { SessionManager } from '../docker/desktop/session-manager.mjs';
function fixture() {
  let now=0, gate=false, unblock; const encoded=[]; const page={};
  const frame=async()=>{if(gate) await new Promise(r=>unblock=r); return {page,png:Buffer.from('SANITIZED_PIXELS'),width:100,height:100};};
  const spawnEncoder=()=>{
    const child=new EventEmitter(); child.exitCode=null; child.stdout=new PassThrough();
    child.stdin=new Writable({write(chunk,_e,cb){encoded.push(Buffer.from(chunk));cb();},final(cb){cb();child.stdout.end(Buffer.from('SAFE_WEBM'));queueMicrotask(()=>{child.exitCode=0;child.emit('close',0);});}});
    child.kill=()=>{child.exitCode=-1;child.emit('close',-1);}; return child;
  };
  const capture=new TeachCapture({}, {frame,spawnEncoder,now:()=>now});
  return {capture,encoded,advance:n=>now+=n,hold:()=>gate=true,release:()=>{gate=false;unblock?.();}};
}
test('no ordinary takeover recording; typed strings and printable shortcuts never enter metadata',async()=>{
  const f=fixture(); await f.capture.around({operation:'input.type',text:'SECRET_SENTINEL'},async()=>({ok:true}));
  assert.equal(f.encoded.length,0); assert.equal(f.capture.artifacts.size,0);
  assert.deepEqual(safeEvent({operation:'input.type',text:'SECRET_SENTINEL'}),{operation:'input.type',source_tag:'web',untrusted:true,redacted:true,length:15});
  assert.deepEqual(safeEvent({operation:'input.key',key:'Control+v'}),{operation:'input.key',source_tag:'web',untrusted:true,redacted:true});
});
test('stop pairs accepted actions, publishes only scoped completed artifacts and preserves monotonic clock',async()=>{
  const f=fixture(),captureId=randomUUID(); await f.capture.command({action:'start',captureId}); f.advance(1234);
  await f.capture.around({operation:'input.type',text:'SECRET_SENTINEL'},async()=>({ok:true}));
  assert.equal(f.capture.events[0].offsetMs,1234);
  await assert.rejects(()=>f.capture.command({action:'artifact',captureId,hash:f.capture.events[0].beforeHash}));
  const stopped=await f.capture.command({action:'stop',captureId});
  assert.equal(stopped.state,'complete');assert.equal(stopped.manifest.durationMs,1234);assert.equal(stopped.eventCount,1);
  assert.equal(JSON.stringify(stopped).includes('SECRET_SENTINEL'),false);
  const shot=await f.capture.command({action:'artifact',captureId,hash:stopped.manifest.events[0].beforeHash}); assert.equal(Buffer.from(shot.base64,'base64').toString(),'SANITIZED_PIXELS');
  await assert.rejects(()=>f.capture.command({action:'artifact',captureId,hash:'f'.repeat(64)}));
  await assert.rejects(()=>f.capture.command({action:'artifact',captureId:randomUUID(),hash:stopped.manifest.videoHash}));
  f.capture.abort();assert.equal(f.capture.artifacts.size,0);
});
test('lease loss during screenshot invalidates buffers before encoding or event persistence',async()=>{
  const f=fixture(),captureId=randomUUID(); await f.capture.command({action:'start',captureId});
  const count=f.encoded.length;f.hold();const tick=f.capture.tick();await new Promise(setImmediate);f.capture.abort();f.release();await tick;
  assert.equal(f.encoded.length,count);assert.equal(f.capture.state,'aborted');assert.equal(f.capture.events.length,0);assert.equal(f.capture.artifacts.size,0);
});
test('CFR video fills elapsed ACTIVE slots with sanitized duplicates and excludes paused wall time',async()=>{
  const f=fixture(),captureId=randomUUID();await f.capture.command({action:'start',captureId});
  assert.equal(f.encoded.length,1);f.advance(1200);await f.capture.tick();assert.equal(f.encoded.length,6);
  f.capture.pause();f.advance(9000);assert.equal(f.capture.activeMs(),1200);
  f.capture.state='recording';f.capture.since=10200;f.advance(800);await f.capture.tick();assert.equal(f.encoded.length,10);
  const stopped=await f.capture.command({action:'stop',captureId});assert.equal(stopped.manifest.durationMs,2000);assert.equal(f.encoded.length,10);
  assert.ok(f.encoded.every(frame=>frame.toString()==='SANITIZED_PIXELS'));
});
test('stalled encoder input fails closed and cannot finalize a truncated capture',async()=>{
  const f=fixture(),captureId=randomUUID();
  f.capture.spawn=()=>{const child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();child.stdin=new Writable({write(){ /* deliberately never acknowledge */ }});child.kill=()=>child.emit('close',-1);return child;};
  const started=await f.capture.command({action:'start',captureId});assert.equal(started.state,'failed');assert.equal(started.reason,'encoder_backpressure');assert.equal(f.capture.artifacts.size,0);
  await assert.rejects(()=>f.capture.command({action:'stop',captureId}));
});
test('unsafe postcondition drops both paired shots and event, pauses without leaking error text',async()=>{
  const f=fixture(),captureId=randomUUID();await f.capture.command({action:'start',captureId});
  await f.capture.around({operation:'input.click',x:1,y:2,button:'left'},async()=>{f.capture.frame=async()=>{throw Error('SECRET_SENTINEL');};return {ok:true};});
  assert.equal(f.capture.state,'paused');assert.equal(f.capture.reason,'safety_check_failed');assert.equal(f.capture.events.length,0);assert.equal(f.capture.artifacts.size,0);f.capture.abort();
});
test('duration and artifact limits fail closed; narration is explicit',async()=>{
  const f=fixture(),captureId=randomUUID();await f.capture.command({action:'start',captureId});f.advance(120000);await f.capture.tick();assert.equal(f.capture.reason,'capture_limit');
  await assert.rejects(()=>f.capture.command({action:'audio',captureId,sequence:0,offsetMs:0,base64:'YQ=='}));
  assert.throws(()=>f.capture.put(Buffer.alloc(5*1024*1024+1),'image/png','before'));f.capture.abort();
});
test('narration creates canonical PCM WAV only behind safety tail and rejects cross-pause intervals',async()=>{
  const f=fixture(),captureId=randomUUID();await f.capture.command({action:'start',captureId,narration:true});f.advance(4000);await f.capture.tick();
  f.capture.spawn=()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>child.emit('close',-1);
    child.stdin=new Writable({write(_chunk,_e,cb){cb();},final(cb){cb();child.stdout.end(Buffer.alloc(4800));queueMicrotask(()=>child.emit('close',0));}});return child;
  };
  const result=await f.capture.command({action:'audio',captureId,sequence:0,offsetMs:0,base64:'YQ==',mime:'audio/webm'});
  assert.equal(result.segment.durationMs,100);const wav=f.capture.artifacts.get(result.segment.hash).bytes;
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(4),wav.length-8);assert.equal(wav.readUInt32LE(40),wav.length-44);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(24),24000);assert.equal(wav.readUInt16LE(34),16);
  const previousSpawn=f.capture.spawn;
  f.capture.spawn=(...args)=>{const child=previousSpawn(...args);child.stdin.on('finish',()=>f.advance(3000));return child;};
  await assert.rejects(()=>f.capture.command({action:'audio',captureId,sequence:1,offsetMs:3500,base64:'YQ==',mime:'audio/webm'}));
  f.capture.pause();f.capture.state='recording';f.capture.since=4000;f.advance(4000);
  await assert.rejects(()=>f.capture.command({action:'audio',captureId,sequence:1,offsetMs:2000,base64:'YQ==',mime:'audio/webm'}));f.capture.abort();
});
test('teach protocol requires full authorization envelope and bounded artifact/audio requests',()=>{
  const valid={ownerId:randomUUID(),agentId:randomUUID(),generation:randomUUID(),requestId:randomUUID(),connectionId:randomUUID(),sessionRef:'a'.repeat(64),leaseId:randomUUID(),captureId:randomUUID(),action:'start'};
  assert.equal(TeachSchema.safeParse(valid).success,true);
  for(const key of ['ownerId','agentId','generation','requestId','connectionId','sessionRef','leaseId']){const v={...valid};delete v[key];assert.equal(TeachSchema.safeParse(v).success,false,key);}
  assert.equal(TeachSchema.safeParse({...valid,action:'artifact'}).success,false);
  assert.equal(TeachSchema.safeParse({...valid,action:'audio',base64:'YQ==',sequence:0,offsetMs:0,mime:'text/html'}).success,false);
});
test('dedicated teach dispatch rechecks viewer lease and rejects cross-owner and duplicate requests',async()=>{
  const manager=new SessionManager(),ownerId=randomUUID(),agentId=randomUUID(),generation=randomUUID();
  const calls=[];const entry={record:{ownerId,agentId},generation,state:'running',vncReady:true,vncPort:5999,vncPassword:'test',channel:{send:async m=>{calls.push(m);return {captureId:m.params.captureId,state:'recording',activeMs:0,eventCount:0,narration:false};}}};
  manager.entries.set(agentId,entry);
  const control={ownerId,agentId,generation,connectionId:randomUUID(),sessionRef:'a'.repeat(64),requestId:randomUUID()};
  const unregister=manager.registerViewer(ownerId,agentId,control,()=>{});const lease=await manager.takeOver(ownerId,agentId,control);
  const command={...control,leaseId:lease.leaseId,captureId:randomUUID(),action:'start'};
  await assert.rejects(()=>manager.teach(randomUUID(),agentId,command));
  await assert.rejects(()=>manager.teach(ownerId,agentId,{...command,leaseId:randomUUID()}));
  assert.equal(calls.length,0);assert.equal((await manager.teach(ownerId,agentId,command)).state,'recording');
  await assert.rejects(()=>manager.teach(ownerId,agentId,command),{code:'duplicate_request_id'});
  // Use a fake private pipe to prove immediate abort bypasses the per-agent work queue.
  const messages=[];entry.child={stdin:new Writable({write(chunk,_e,cb){messages.push(chunk);cb();}})};
  unregister();assert.equal(entry.teachActive,false);assert.equal(manager.takeovers.has(agentId),false);assert.equal(messages.length,1);
  const body=messages[0].subarray(4);assert.deepEqual(JSON.parse(body),{command:'teach-abort'});
  await assert.rejects(()=>manager.teach(ownerId,agentId,{...command,requestId:randomUUID(),action:'status'}),{code:'viewer_not_active'});
});
test('screenshot is masked at collection and a safety change rejects the uncommitted frame',async()=>{
  let checks=0, options;
  const png=Buffer.alloc(33);png.writeUInt32BE(100,16);png.writeUInt32BE(100,20);
  const page={isClosed:()=>false,url:()=> 'http://demo/invoices?secret=sentinel',frames:()=>[{}],locator:selector=>{assert.equal(selector,MASK_SELECTOR);return {};},evaluate:async fn=>{if(fn.toString().includes('const semantics'))return ++checks>1?'sensitive_surface':null;return true;},screenshot:async opts=>{options=opts;return png;}};
  const context={pages:()=>[page],newCDPSession:async()=>({send:async method=>method==='Runtime.evaluate'?{result:{objectId:'proto'}}:method==='Runtime.queryObjects'?{objects:{objectId:'roots'}}:method==='Runtime.callFunctionOn'?{result:{value:0}}:{},detach:async()=>{}})};
  await assert.rejects(()=>sanitizedFrame(context),/sensitive_surface/);assert.equal(options.maskColor,'#000000');assert.equal(options.mask.length,1);assert.equal(Object.hasOwn(options,'path'),false);
});
