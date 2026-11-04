import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseASR as parseAudioASR, validateWave as validateAudioWave } from "../audio/transcribe";
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
const asNarrationError = (error: unknown): NarrationError =>
  error instanceof NarrationError ? error : new NarrationError((error as { code?: string } | null)?.code ?? "invalid_audio");
// Teach keeps its own error name and limits; the validators live in lib/audio/transcribe.ts.
export function validateWave(input: Uint8Array): { durationMs: number } {
  try { return validateAudioWave(input); } catch (error) { throw asNarrationError(error); }
}
export function parseASR(value: unknown, durationMs: number, offsetMs = 0) {
  try { return parseAudioASR(value, durationMs, offsetMs); } catch (error) { throw asNarrationError(error); }
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
