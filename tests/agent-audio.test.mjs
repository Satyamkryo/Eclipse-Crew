import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { OperationSchema, resultFor, validateWave } from "../docker/desktop/controller-schema.mjs";
import { AgentAudio } from "../docker/desktop/agent-audio.mjs";
import { intentSchema } from "../lib/agent/intent.ts";
import { AUDIO_ACTIONS } from "../lib/agents/actions.ts";
import { transcriptText } from "../lib/audio/transcribe.ts";
import { compileFromReceipts } from "../lib/replay/script.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function wave({ seconds = 1, rate = 24000, channels = 1, bits = 16 } = {}) {
  const dataBytes = Math.floor(seconds * rate) * channels * (bits / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * channels * (bits / 8), 28); buffer.writeUInt16LE(channels * (bits / 8), 32);
  buffer.writeUInt16LE(bits, 34); buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

test("audio.capture accepts 1-30 seconds only and the WAV result is canonical", () => {
  assert.equal(OperationSchema.safeParse({ operation: "audio.capture", seconds: 5 }).success, true);
  for (const seconds of [0, 31, 1.5]) assert.equal(OperationSchema.safeParse({ operation: "audio.capture", seconds }).success, false);
  assert.equal(OperationSchema.safeParse({ operation: "audio.capture", seconds: 5, extra: true }).success, false);
  const bytes = wave({ seconds: 1 });
  assert.deepEqual(validateWave(bytes), { durationMs: 1000 });
  const result = { base64: bytes.toString("base64"), mime: "audio/wav", durationMs: 1000, source_tag: "tool", untrusted: true };
  assert.equal(resultFor("audio.capture", result).durationMs, 1000);
  for (const mutate of [
    (b) => b.writeUInt16LE(2, 22), (b) => b.writeUInt32LE(16000, 24), (b) => b.writeUInt16LE(8, 34),
    (b) => b.writeUInt32LE(0xffffffff, 4), (b) => b.writeUInt32LE(3, 40),
  ]) { const bad = wave({ seconds: 1 }); mutate(bad); assert.throws(() => validateWave(bad), /invalid_wave/); }
  assert.throws(() => validateWave(wave({ seconds: 50 })), /invalid_wave/);
  assert.throws(() => resultFor("audio.capture", { ...result, durationMs: 2000 }), /invalid_wave/);
  assert.throws(() => resultFor("audio.capture", { ...result, base64: result.base64.slice(0, -4) }), /invalid_wave|invalid_audio/);
});

test("AgentAudio rejects caller-selected paths and uids before any filesystem work", () => {
  const base = { directory: "/tmp/ec-20000-abcdef", home: `/workspace/homes/${ID}`, uid: 20000, env: {} };
  assert.ok(new AgentAudio(base));
  for (const bad of [{ ...base, directory: "/tmp/ec-20000-../x" }, { ...base, home: "/root" }, { ...base, uid: 0 }, { ...base, uid: 60000 }, { ...base, env: null }])
    assert.throws(() => new AgentAudio(bad), /invalid_audio_path/);
});

test("hearing is an opt-in action and its transcript formatter is bounded", () => {
  assert.deepEqual([...AUDIO_ACTIONS], ["hear_audio"]);
  assert.equal(intentSchema.safeParse({ action: "hear_audio", seconds: 10, expect: "spoken time" }).success, true);
  assert.equal(transcriptText([{ text: " hello " }, { text: "world " }]), "hello world");
  assert.equal(transcriptText([{ text: "x".repeat(5000) }]).length, 4000);
});

test("a replay with hearing fails explicitly before executing or spending", () => {
  const receipt = JSON.stringify({ idx: 1, action: { kind: "hear_audio", seconds: 5, chars: 10, duration_ms: 5000 }, result: "pass", executed: true });
  const compiled = compileFromReceipts([{ idx: 1, receipt }]);
  assert.equal(compiled.ok, false);
  assert.deepEqual(compiled.reasons, [{ step: 1, code: "audio_not_replayable" }]);
});

test("the desktop and worker wire capture with a capture-specific timeout and cancellation", async () => {
  const worker = await readFile("docker/desktop/session-worker.mjs", "utf8");
  assert.match(worker, /new AgentAudio/);
  assert.match(worker, /await audio\.start\(\)/);
  assert.match(worker, /audio\.capture/);
  assert.match(worker, /capture-abort/);
  assert.match(worker, /parsed\.data\.seconds \+ 5/);
  const client = await readFile("lib/desktop/client.ts", "utf8");
  assert.match(client, /"audio\.capture"/);
  assert.match(client, /Number\(args\.seconds\) \+ 10/);
  const manager = await readFile("docker/desktop/session-manager.mjs", "utf8");
  assert.match(manager, /operation === "audio\.capture" \? \(Number\(fields\.seconds\) \+ 8\)/);
  const dockerfile = await readFile("docker/desktop/Dockerfile", "utf8");
  assert.match(dockerfile, /agent-audio\.mjs/);
});
