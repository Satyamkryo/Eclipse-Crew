import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { getDatabase } from "../../db/client";
import { createModelSettingsStore } from "../models/data";
import { createAudioProxyTransport } from "../providers/proxy-transport";
import { decryptSecret } from "../security/encryption";
import { priceFor, readBudgetStatus, setAgentAttention } from "../costs/store";
import type { RunCostSink } from "../costs/types";
import { AudioError, parseASR, transcriptText, validateWave } from "./transcribe";

const MODEL = "muse-voice-transcribe-1.0";
const MAX_AGENT_AUDIO_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

// TASK-079. One bounded hearing attempt. The charge is reserved before dispatch; an uncertain upstream
// answer is never retried and its attempted-duration row stays. No teach capture row is created.
export async function transcribeAgentAudio(options: {
  database: Awaited<ReturnType<typeof getDatabase>>;
  ownerId: string; agentId: string; wav: Uint8Array; costs: RunCostSink; key?: string;
}) {
  const { database, ownerId, agentId, wav, costs, key } = options;
  let durationMs: number;
  try { ({ durationMs } = validateWave(wav)); } catch { throw new AudioError("invalid_audio"); }
  if (durationMs < 1 || durationMs > MAX_AGENT_AUDIO_MS) throw new AudioError("invalid_audio");
  const main = (await createModelSettingsStore(database).load(ownerId)).main;
  const provider = main?.provider;
  if (provider?.kind !== "meta" || !provider.encryptedKey) throw new AudioError("audio_provider_unavailable");
  const price = await priceFor(database, ownerId, provider.id, MODEL);
  if (!price || price.audioMicroUsdPerHour === undefined) throw new AudioError("price_required");
  const budget = await readBudgetStatus(database, ownerId, agentId, new Date());
  if (budget.state === "paused") {
    await setAgentAttention(database, ownerId, agentId, "budget_paused", { pause: true });
    throw new AudioError("budget_paused");
  }
  const reservation = await costs.reserveAudio({ providerId: provider.id, kind: "meta", baseUrl: null, model: MODEL, durationMs,
    key: key ?? randomUUID() });
  if (reservation.duplicate) throw new AudioError("audio_already_attempted");
  let turns: ReturnType<typeof parseASR> | undefined;
  try {
    const send = createAudioProxyTransport({ credential: decryptSecret(provider.encryptedKey) });
    const response = await send(wav);
    if (!response.ok) throw new AudioError("audio_uncertain");
    const reader = response.body?.getReader();
    if (!reader) throw new AudioError("audio_uncertain");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new AudioError("audio_uncertain"); }
      chunks.push(item.value);
    }
    turns = parseASR(JSON.parse(Buffer.concat(chunks).toString("utf8")), durationMs, 0);
  } catch { /* Never surface upstream content and never automatically retry a paid request. */ }
  if (!turns) throw new AudioError("audio_uncertain");
  const text = transcriptText(turns);
  return {
    text, noSpeech: text.length === 0, durationMs, model: MODEL,
    sha256: createHash("sha256").update(Buffer.from(wav)).digest("hex"), bytes: wav.byteLength,
  };
}
