import assert from "node:assert/strict";
import test from "node:test";

function wave(ms = 1000) {
  const bytes = ms * 48, buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36);
  buffer.writeUInt32LE(bytes, 40); return buffer;
}

function fakeCosts() {
  const calls = [], seen = new Set();
  return { calls, beforeCall: async () => {}, recordCall: async () => {}, totalMicroUsd: () => 0,
    reserveAudio: async (call) => { calls.push(call);
      if (call.key && seen.has(call.key)) return { duplicate: true, costMicroUsd: 180, callIndex: 1 };
      if (call.key) seen.add(call.key);
      return { duplicate: false, costMicroUsd: 180, callIndex: calls.length }; } };
}

test("agent hearing charges once before dispatch and returns bounded untrusted text", async () => {
  const { transcribeAgentAudio } = await import("../lib/audio/service.ts");
  const { encryptSecret } = await import("../lib/security/encryption.ts");
  const oldKey = process.env.ENCRYPTION_KEY, oldProxy = process.env.EGRESS_PROXY_SECRET, oldFetch = globalThis.fetch;
  process.env.ENCRYPTION_KEY = "12".repeat(32); process.env.EGRESS_PROXY_SECRET = "34".repeat(32);
  const ownerId = "00000000-0000-4000-8000-000000000001", agentId = "00000000-0000-4000-8000-000000000002";
  const providerId = "00000000-0000-4000-8000-000000000004";
  const role = { role: "main", providerId, providerOwnerId: ownerId, kind: "meta", encryptedKey: encryptSecret("synthetic-asr-key"), baseUrl: null, model: "muse-spark-1.3" };
  const makeDb = (rows = [[role], [{ kind: "meta", baseUrl: null, input: null, cached: null, output: null, image: null, audio: null }],
    [{ timezone: "UTC", dailyLimitCents: 100, monthlyLimitCents: 1000, attention: null }], [{ day: "0", month: "0" }]]) => {
    const queue = [...rows];
    return { update() { const q = { set() { return q; }, where() { return q; }, async returning() { return [{ id: agentId }]; } }; return q; },
      select() { const value = queue.shift(); const q = { from() { return q; }, where() { return q; }, leftJoin() { return q; }, innerJoin() { return q; },
        limit() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; return q; } };
  };
  const costs = fakeCosts();
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ audioDurationMs: 1000,
      turns: [{ startMs: 0, endMs: 900, transcript: "The meeting starts at three." }] })); };
    const result = await transcribeAgentAudio({ database: makeDb(), ownerId, agentId, runId: "run-1", wav: wave(), costs, key: "audio:1" });
    assert.equal(calls, 1);
    assert.equal(result.text, "The meeting starts at three.");
    assert.equal(result.noSpeech, false);
    assert.equal(result.durationMs, 1000);
    assert.equal(result.model, "muse-voice-transcribe-1.0");
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(costs.calls.map((call) => [call.durationMs, call.model, call.key]), [[1000, "muse-voice-transcribe-1.0", "audio:1"]]);
    await assert.rejects(() => transcribeAgentAudio({ database: makeDb([[]]), ownerId, agentId, runId: "run-1", wav: wave(), costs }), (error) => error.code === "audio_provider_unavailable");
    await assert.rejects(() => transcribeAgentAudio({ database: makeDb(), ownerId, agentId, runId: "run-1", wav: Buffer.alloc(44), costs }), (error) => error.code === "invalid_audio");
    await assert.rejects(() => transcribeAgentAudio({ database: makeDb(), ownerId, agentId, runId: "run-1", wav: wave(), costs,
      key: "audio:1" }), (error) => error.code === "audio_already_attempted", "a duplicate key does not resend");
    assert.equal(calls, 1, "duplicate and invalid attempts never reach the provider");
    globalThis.fetch = async () => { calls += 1; throw Error("synthetic upstream secret"); };
    const uncertain = fakeCosts();
    await assert.rejects(() => transcribeAgentAudio({ database: makeDb(), ownerId, agentId, runId: "run-2", wav: wave(), costs: uncertain }), (error) => error.code === "audio_uncertain");
    assert.equal(calls, 2);
    assert.equal(uncertain.calls.length, 1, "one charge for one uncertain attempt, no retry");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = oldKey;
    if (oldProxy === undefined) delete process.env.EGRESS_PROXY_SECRET; else process.env.EGRESS_PROXY_SECRET = oldProxy;
  }
});
