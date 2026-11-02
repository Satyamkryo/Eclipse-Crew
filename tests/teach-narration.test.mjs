import assert from "node:assert/strict";
import test from "node:test";
import {validateWave,parseASR} from "../lib/teach/transcribe.ts";
import {audioMultipart} from "../docker/egress/proxy.mjs";
import {calculateCostMicroUsd,META_PRICES} from "../lib/costs/pricing.ts";
import {createAudioProxyTransport} from "../lib/providers/proxy-transport.ts";
function wave(ms=1000) {const bytes=ms*48,b=Buffer.alloc(44+bytes);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(bytes,40);return b;}
test('WAV enforces PCM format, chunk lengths, size and duration',()=>{
 assert.deepEqual(validateWave(wave()),{durationMs:1000});
 for(const mutate of [b=>b.writeUInt16LE(2,22),b=>b.writeUInt32LE(16000,24),b=>b.writeUInt32LE(0xffffffff,4),b=>b.writeUInt32LE(500000,40)]) {const b=wave();mutate(b);assert.throws(()=>validateWave(b),/invalid_audio/);assert.throws(()=>audioMultipart(b));}
 assert.throws(()=>validateWave(Buffer.alloc(3*1024*1024+1)));
});
test('ASR turns preserve offset and reject out of bounds, unordered and control text',()=>{
 const value={audioDurationMs:1000,turns:[{startMs:10,endMs:900,transcript:'Synthetic explanation'}]};
 assert.deepEqual(parseASR(value,1000,200),[{startMs:210,endMs:1100,text:'Synthetic explanation'}]);
 assert.throws(()=>parseASR({...value,audioDurationMs:1001},1000));
 assert.throws(()=>parseASR({...value,turns:[{startMs:0,endMs:1001,transcript:'no'}]},1000));
 assert.throws(()=>parseASR({...value,turns:[{startMs:0,endMs:1,transcript:'\u0000'}]},1000));
});
test('audio price is integer microUSD at verified whole-second billing rate',()=>{
 const p=META_PRICES['muse-voice-transcribe-1.0'],u={inputTokens:0,outputTokens:0,cachedInputTokens:0};
 assert.equal(calculateCostMicroUsd(p,u,{audioDurationMs:999}),0);
 assert.equal(calculateCostMicroUsd(p,u,{audioDurationMs:1000}),50);
 assert.equal(calculateCostMicroUsd(p,u,{audioDurationMs:60000}),3000);
});
test('fixed audio transport sends bounded audio only to dedicated private proxy route',async()=>{
 let seen;
 const send=createAudioProxyTransport({credential:'sk-synthetic-only',secret:'ab'.repeat(32),fetchImpl:async(url,init)=>{seen={url,init};return new Response('{}');}});
 await send(wave());assert.equal(seen.url,'http://egress-proxy:4320/v1/teach-asr');assert.equal(seen.init.headers['X-Eclipse-Target'],undefined);
 const multipart=audioMultipart(wave()).toString();assert.match(multipart,/"mode":"ENDPOINTING"/);assert.match(multipart,/muse-voice-transcribe-1.0/);assert.doesNotMatch(multipart,/sk-synthetic/);
 await assert.rejects(()=>send(Buffer.alloc(3*1024*1024+1)),/invalid_audio/);
});

test('transcriber rejects owner-scoped missing captures and already costed segments before provider work',async()=>{
 const {transcribeNarration}=await import('../lib/teach/transcribe.ts');
 const databaseFor=(results)=>({select(){const value=results.shift();const q={from(){return q;},leftJoin(){return q;},where(){return q;},limit(){return Promise.resolve(value);},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}};return q;}});
 const base={ownerId:'00000000-0000-4000-8000-000000000001',agentId:'00000000-0000-4000-8000-000000000002',captureId:'00000000-0000-4000-8000-000000000003',sequence:0,offsetMs:0,wav:wave()};
 await assert.rejects(()=>transcribeNarration({...base,database:databaseFor([[]])}),/capture_not_found/);
 await assert.rejects(()=>transcribeNarration({...base,database:databaseFor([[{id:base.captureId}],[{id:'prior'}]])}),/narration_already_transcribed/);
 await assert.rejects(()=>transcribeNarration({...base,database:databaseFor([[{id:base.captureId}],[],[]])}),/narration_provider_unavailable/);
});


test('transcriber records one scoped audio ledger entry and treats remote failure as uncertain without retry',async()=>{
 const {transcribeNarration}=await import('../lib/teach/transcribe.ts');const {encryptSecret}=await import('../lib/security/encryption.ts');
 const oldKey=process.env.ENCRYPTION_KEY,oldProxy=process.env.EGRESS_PROXY_SECRET,oldFetch=globalThis.fetch;
 process.env.ENCRYPTION_KEY='12'.repeat(32);process.env.EGRESS_PROXY_SECRET='34'.repeat(32);
 const ownerId='00000000-0000-4000-8000-000000000001',agentId='00000000-0000-4000-8000-000000000002',captureId='00000000-0000-4000-8000-000000000003',providerId='00000000-0000-4000-8000-000000000004';
 const role={role:'main',providerId,providerOwnerId:ownerId,kind:'meta',encryptedKey:encryptSecret('synthetic-asr-key'),baseUrl:null,model:'muse-spark-1.3'};
 const makeDb=(spent='0')=>{const rows=[[{id:captureId}],[],[role],[{kind:'meta',baseUrl:null,input:null,cached:null,output:null,image:null,audio:null}],[{timezone:'UTC',dailyLimitCents:100,monthlyLimitCents:1000,attention:null}],[{day:spent,month:spent}]];const inserted=[];return {inserted,update(){const q={set(){return q;},where(){return q;},async returning(){return[{id:agentId}];}};return q;},select(){const value=rows.shift();const q={from(){return q;},where(){return q;},leftJoin(){return q;},innerJoin(){return q;},limit(){return Promise.resolve(value);},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}};return q;},insert(){return{values(value){inserted.push(value);return{async onConflictDoNothing(){}};}};}};};
 try {
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({audioDurationMs:1000,turns:[{startMs:0,endMs:900,transcript:'Synthetic narration'}]}));};
  const database=makeDb();const input={ownerId,agentId,captureId,database,sequence:2,offsetMs:500,wav:wave()};
  assert.deepEqual(await transcribeNarration(input),{turns:[{startMs:500,endMs:1400,text:'Synthetic narration'}],source_tag:'tool',untrusted:true});
  assert.equal(calls,1);assert.equal(database.inserted.length,1);const row=database.inserted[0];assert.equal(row.idempotencyKey,`teach:${captureId}:asr:2`);assert.equal(row.runId,null);assert.equal(row.captureId,captureId);assert.equal(row.audioDurationMs,1000);assert.equal(row.costMicroUsd,50);assert.equal(row.outcome,'asr_complete');
  await assert.rejects(()=>transcribeNarration({...input,database:makeDb('1000000')}),/budget_paused/);assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;throw new Error('synthetic upstream secret never exposed');};const uncertain=makeDb();await assert.rejects(()=>transcribeNarration({...input,database:uncertain}),/^NarrationError: narration_uncertain$/);assert.equal(calls,2);assert.equal(uncertain.inserted[0].outcome,'asr_uncertain');assert.equal(uncertain.inserted[0].costMicroUsd,50);
 } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=oldKey;if(oldProxy===undefined)delete process.env.EGRESS_PROXY_SECRET;else process.env.EGRESS_PROXY_SECRET=oldProxy;}
});
