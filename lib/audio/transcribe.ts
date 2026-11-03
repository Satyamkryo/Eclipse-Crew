import { z } from "zod";

// TASK-079. Pure audio/transcript validation shared by teach narration and agent hearing. No database,
// proxy or storage code here, so tests can exercise the exact limits without a provider.
export class AudioError extends Error {
  constructor(public code: string) { super(code); this.name = "AudioError"; }
}
const fail = (code: string): never => { throw new AudioError(code); };

// Canonical WAV: mono 24 kHz PCM16, at most 3 MiB / 120 s. LIST metadata is tolerated; anything else is refused.
export function validateWave(input: Uint8Array): { durationMs: number } {
  const wav = Buffer.from(input);
  if (wav.length < 44 || wav.length > 3 * 1024 * 1024 || wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) !== wav.length - 8) return fail("invalid_audio");
  let fmt = false, bytes = 0;
  for (let offset = 12; offset < wav.length;) {
    if (offset + 8 > wav.length) return fail("invalid_audio");
    const name = wav.toString("ascii", offset, offset + 4), size = wav.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end > wav.length) return fail("invalid_audio");
    if (name === "fmt ") {
      if (fmt || size !== 16 || wav.readUInt16LE(offset + 8) !== 1 || wav.readUInt16LE(offset + 10) !== 1 ||
          wav.readUInt32LE(offset + 12) !== 24000 || wav.readUInt32LE(offset + 16) !== 48000 ||
          wav.readUInt16LE(offset + 20) !== 2 || wav.readUInt16LE(offset + 22) !== 16) return fail("invalid_audio");
      fmt = true;
    } else if (name === "data") { if (bytes || !size || size % 2) return fail("invalid_audio"); bytes = size; }
    else if (name !== "JUNK" && name !== "LIST") return fail("invalid_audio");
    offset = end + (size % 2);
    if (offset > wav.length) return fail("invalid_audio");
  }
  if (!fmt || !bytes) return fail("invalid_audio");
  return { durationMs: Math.ceil(bytes / 48) };
}

const asrSchema = z.object({
  audioDurationMs: z.number().int().nonnegative().max(120000),
  turns: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(), transcript: z.string().max(16000) })).max(300),
});
export function parseASR(value: unknown, durationMs: number, offsetMs = 0) {
  const parsed = asrSchema.safeParse(value);
  if (!parsed.success || parsed.data.audioDurationMs > durationMs || !Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs + durationMs > 120000)
    return fail("invalid_transcript");
  let last = 0;
  return parsed.data.turns.map((turn) => {
    if (turn.startMs < last || turn.endMs < turn.startMs || turn.endMs > parsed.data.audioDurationMs || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(turn.transcript))
      return fail("invalid_transcript");
    last = turn.startMs;
    return { startMs: offsetMs + turn.startMs, endMs: offsetMs + turn.endMs, text: turn.transcript };
  });
}

// The model sees one bounded plain-text block; the raw audio and turn times never reach it.
export function transcriptText(turns: readonly { text: string }[], max = 4000): string {
  return turns.map((turn) => turn.text).join(" ").replace(/\s+/g, " ").trim().slice(0, max);
}
