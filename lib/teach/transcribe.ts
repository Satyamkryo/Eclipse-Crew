import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { getDatabase } from "../../db/client";
import { costEntries, teachRecordings } from "../../db/schema";
import { createModelSettingsStore } from "../models/data";
import { createAudioProxyTransport } from "../providers/proxy-transport";
import { decryptSecret } from "../security/encryption";
import { calculateCostMicroUsd } from "../costs/pricing";
import { priceFor, readBudgetStatus, setAgentAttention } from "../costs/store";

export class NarrationError extends Error {
  constructor(public code: string) { super(code); this.name = "NarrationError"; }
}
const fail = (): never => { throw new NarrationError("invalid_audio"); };
export function validateWave(input: Uint8Array): { durationMs: number } {
  const wav = Buffer.from(input);
  if (wav.length < 44 || wav.length > 3 * 1024 * 1024 || wav.toString("ascii",0,4) !== "RIFF" || wav.toString("ascii",8,12) !== "WAVE" || wav.readUInt32LE(4) !== wav.length-8) return fail();
  let fmt=false, bytes=0;
  for(let offset=12;offset<wav.length;) {
    if(offset+8>wav.length) return fail();
    const name=wav.toString("ascii",offset,offset+4), size=wav.readUInt32LE(offset+4), end=offset+8+size;
    if(end>wav.length) return fail();
    if(name==="fmt ") {
      if(fmt || size!==16 || wav.readUInt16LE(offset+8)!==1 || wav.readUInt16LE(offset+10)!==1 || wav.readUInt32LE(offset+12)!==24000 || wav.readUInt32LE(offset+16)!==48000 || wav.readUInt16LE(offset+20)!==2 || wav.readUInt16LE(offset+22)!==16) return fail();
      fmt=true;
    } else if(name==="data") { if(bytes || !size || size%2) return fail(); bytes=size; }
    else if(name!=="JUNK") return fail();
    offset=end+(size%2);
    if(offset>wav.length) return fail();
  }
  if(!fmt || !bytes) return fail();
  return { durationMs: Math.ceil(bytes/48) };
}
const asrSchema=z.object({
  audioDurationMs:z.number().int().nonnegative().max(120000),
  turns:z.array(z.object({ startMs:z.number().int().nonnegative(), endMs:z.number().int().nonnegative(), transcript:z.string().max(16000) })).max(300),
});
export function parseASR(value: unknown, durationMs:number, offsetMs=0) {
  const parsed=asrSchema.safeParse(value);
  if(!parsed.success || parsed.data.audioDurationMs>durationMs || !Number.isSafeInteger(offsetMs) || offsetMs<0 || offsetMs+durationMs>120000) throw new NarrationError("invalid_transcript");
  let last=0;
  return parsed.data.turns.map(turn=>{
    if(turn.startMs<last || turn.endMs<turn.startMs || turn.endMs>parsed.data.audioDurationMs || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(turn.transcript)) throw new NarrationError("invalid_transcript");
    last=turn.startMs;
    return { startMs:offsetMs+turn.startMs, endMs:offsetMs+turn.endMs, text:turn.transcript };
  });
}
export async function transcribeNarration(options:{
  database:Awaited<ReturnType<typeof getDatabase>>; ownerId:string; agentId:string; captureId:string;
  sequence:number; offsetMs:number; wav:Uint8Array; timezone?:string;
}) {
  const {database,ownerId,agentId,captureId,sequence,offsetMs,wav}=options;
  const {durationMs}=validateWave(wav);
  if(!Number.isSafeInteger(sequence)||sequence<0||sequence>299||!Number.isSafeInteger(offsetMs)||offsetMs<0||offsetMs+durationMs>120000) throw new NarrationError("invalid_audio");
  const capture=await database.select({id:teachRecordings.id}).from(teachRecordings).where(and(eq(teachRecordings.ownerId,ownerId),eq(teachRecordings.agentId,agentId),eq(teachRecordings.id,captureId))).limit(1);
  if(!capture[0]) throw new NarrationError("capture_not_found");
  const idempotencyKey=`teach:${captureId}:asr:${sequence}`;
  const prior=await database.select({id:costEntries.id}).from(costEntries).where(and(eq(costEntries.ownerId,ownerId),eq(costEntries.idempotencyKey,idempotencyKey))).limit(1);
  if(prior[0]) throw new NarrationError("narration_already_transcribed");
  const main=(await createModelSettingsStore(database).load(ownerId)).main;
  const provider=main?.provider;
  if(provider?.kind!=="meta"||!provider.encryptedKey) throw new NarrationError("narration_provider_unavailable");
  const model="muse-voice-transcribe-1.0";
  const price=await priceFor(database,ownerId,provider.id,model);
  if(!price || price.audioMicroUsdPerHour===undefined) throw new NarrationError("price_required");
  const budget=await readBudgetStatus(database,ownerId,agentId,new Date());
  if(budget.state==="paused") { await setAgentAttention(database,ownerId,agentId,"budget_paused",{pause:true}); throw new NarrationError("budget_paused"); }
  let send:ReturnType<typeof createAudioProxyTransport>;
  try {send=createAudioProxyTransport({credential:decryptSecret(provider.encryptedKey)});} catch {throw new NarrationError("narration_provider_unavailable");}
  let turns:ReturnType<typeof parseASR>|undefined;
  let outcome="asr_uncertain";
  try {
    const response=await send(wav);
    if(!response.ok) throw new NarrationError("narration_uncertain");
    const reader=response.body?.getReader(); const chunks:Uint8Array[]=[]; let size=0;
    if(!reader) throw new NarrationError("narration_uncertain");
    for(;;) {const item=await reader.read();if(item.done) break;size+=item.value.byteLength;if(size>256*1024){await reader.cancel();throw new NarrationError("invalid_transcript");}chunks.push(item.value);}
    turns=parseASR(JSON.parse(Buffer.concat(chunks).toString("utf8")),durationMs,offsetMs);
    outcome="asr_complete";
  } catch { /* Never surface upstream content or automatically retry an uncertain paid request. */ }
  try {
    await database.insert(costEntries).values({id:randomUUID(),ownerId,agentId,captureId,runId:null,providerId:provider.id,callIndex:sequence+1,model,tokensIn:0,tokensOut:0,tokensCached:0,audioDurationMs:durationMs,costMicroUsd:calculateCostMicroUsd(price,{inputTokens:0,outputTokens:0,cachedInputTokens:0},{audioDurationMs:durationMs}),outcome,idempotencyKey}).onConflictDoNothing({target:costEntries.idempotencyKey});
  } catch {throw new NarrationError("narration_uncertain");}
  if(!turns) throw new NarrationError("narration_uncertain");
  return {turns,source_tag:"tool" as const,untrusted:true as const};
}
