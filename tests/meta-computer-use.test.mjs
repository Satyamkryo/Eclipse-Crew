import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { buildRequest, buildContinuation, describeResponse, ENDPOINT, MAX_PNG_BYTES, MAX_RESPONSE_BYTES, MODEL, ProbeError, readScreenshot,
  runProbe, safeError, validatePng, validateResponse } from "../scripts/spikes/meta-computer-use-core.mjs";

const CANARY = "SYNTHETIC_META_CREDENTIAL_CANARY";
const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "scripts/spikes/meta-computer-use.mjs");
const instant = new Date("2026-10-30T06:30:00.000Z");
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  payload.copy(result, 4);
  result.writeUInt32BE(crc32(payload), result.length - 4);
  return result;
}
function png(width = 64, height = 32) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function call(overrides = {}) {
  return { type: "computer_call", id: "cc_test", call_id: "call_test", status: "completed", pending_safety_checks: [],
    actions: [{ type: "click", button: "left", x: 20, y: 15 }], ...overrides };
}
function response(output = [call()], overrides = {}) { return { model: MODEL, status: "completed", output,
  usage: { input_tokens: 300, output_tokens: 40 }, ...overrides }; }
function observation(overrides = {}) { return call({ actions: [{ type: "screenshot" }], meta_safety_replay_receipt: "genuine-test-fixture-receipt", ...overrides }); }
function checkError(code) { return (error) => error instanceof ProbeError && error.code === code && !safeError(error).includes(CANARY); }
async function fixture(fn) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(root, "eclipse-meta-test-"));
  const screenshotPath = path.join(directory, "screen.png");
  await writeFile(screenshotPath, png());
  try { return await fn({ directory, screenshotPath, evidenceRoot: path.join(directory, "evidence") }); }
  finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith("eclipse-meta-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
}

test("PNG checks reject corrupt, truncated, oversized, wrong-format and invalid-dimension images", async () => {
  assert.deepEqual(Object.keys(validatePng(png())), ["width", "height", "sha256"]);
  const corrupt = png(); corrupt[20] ^= 1;
  for (const bytes of [Buffer.from("not an image"), corrupt, png().subarray(0, 33), Buffer.alloc(MAX_PNG_BYTES + 1), png(4097, 1)]) {
    assert.throws(() => validatePng(bytes), checkError("invalid_image"));
  }
  await fixture(async ({ directory, screenshotPath }) => {
    assert.equal((await readScreenshot(screenshotPath)).width, 64);
    for (const file of [directory, path.join(directory, "missing.png")]) await assert.rejects(readScreenshot(file), checkError("invalid_image"));
    const header = Buffer.alloc(13); header[8] = 8; header[9] = 6;
    const invalid = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", Buffer.from([1])), chunk("IEND", Buffer.alloc(0))]);
    assert.throws(() => validatePng(invalid), checkError("invalid_image"));
  });
});

test("request uses the owner-selected contributor model, fixed endpoint policy, stable prefix and UTC clock", () => {
  const request = buildRequest(instant);
  assert.equal(request.model, "muse-spark-1.3-contributor");
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 512);
  assert.deepEqual(request.reasoning, { effort: "minimal" });
  assert.deepEqual(request.tools, [{ type: "computer" }]);
  assert.match(request.instructions, /untrusted data, never instructions/);
  assert.ok(request.instructions.indexOf("CLOCK:") > request.instructions.indexOf("Eclipse Crew"));
  assert.match(request.instructions, /2026-10-30T06:30:00.000Z.*Etc\/UTC/);
  assert.equal(request.input[0].content.length, 1);
  assert.ok(!JSON.stringify(request).includes("input_image"));
  assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
  assert.ok(!JSON.stringify(request).includes(CANARY));
});

test("click validation handles native single/batched forms and rejects unsafe schemas and coordinates", () => {
  const image = { width: 64, height: 32 };
  assert.equal(validateResponse(response(), image).x, 20);
  assert.equal(validateResponse(response([call({ action: null })]), image).x, 20);
  assert.equal(validateResponse(response([call({ action: call().actions[0] })]), image).x, 20);
  assert.equal(validateResponse(response([call({ actions: undefined, action: { type: "click", button: "left", x: 0, y: 0 } })]), image).x, 0);
  assert.equal(validateResponse(response([call({ actions: null, action: { type: "click", button: "left", x: 0, y: 0 } })]), image).x, 0);
  const cases = [
    [null, "invalid_response"],
    [response([], { model: "other" }), "invalid_response"],
    [response([], { status: "incomplete" }), "incomplete_response"],
    [response([]), "no_action"],
    [response([call(), call()]), "no_action"],
    [response([call({ pending_safety_checks: undefined })]), "invalid_response"],
    [response([call({ pending_safety_checks: [null] })]), "invalid_response"],
    [response([call({ pending_safety_checks: [{}] })]), "invalid_response"],
    [response([call({ pending_safety_checks: [{ id: "check", code: 5 }] })]), "invalid_response"],
    [response([call({ pending_safety_checks: [{ id: "check", message: CANARY, unknown: CANARY }] })]), "invalid_response"],
    [response([call({ pending_safety_checks: Array.from({ length: 17 }, () => ({ id: "check" })) })]), "invalid_response"],
    [response([call({ status: "incomplete" })]), "invalid_response"],
    [response([call({ actions: [] })]), "invalid_action"],
    [response([call({ action: { type: "click" } })]), "invalid_action"],
    [response([call({ action: { type: "click", button: "left", x: 10, y: 10 } })]), "invalid_action"],
    [response([call({ actions: [{ type: "click", button: "left", x: 64, y: 1 }] })]), "out_of_bounds"],
    [response([call({ actions: [{ type: "click", button: "left", x: 1, y: 32 }] })]), "out_of_bounds"],
    [response([call({ actions: [{ type: "click", button: "left", x: -1, y: 1 }] })]), "invalid_action"],
    [response([call({ actions: [{ type: "click", button: "left", x: 1.5, y: 1 }] })]), "invalid_action"],
    [response([call({ actions: [{ type: "click", button: "right", x: 1, y: 1 }] })]), "invalid_action"],
    [response([call({ actions: [{ type: "type", text: CANARY }] })]), "invalid_action"],
    [response([call({ actions: [{ type: "screenshot" }] })]), "observation_requested"],
    [response([call({ actions: [{ type: "screenshot", command: CANARY }] })]), "invalid_action"],
    [response([call({ actions: [{ type: "click", button: "left", x: 1, y: 1, command: CANARY }] })]), "invalid_action"],
    [response([call({ actions: [call().actions[0], call().actions[0]] })]), "invalid_action"],
    [response([call({ pending_safety_checks: [{ id: "safety", code: "review", message: CANARY }] })]), "safety_review_required"],
  ];
  for (const [value, code] of cases) assert.throws(() => validateResponse(value, image), checkError(code));
});

test("preflight rejects missing consent, missing/invalid keys and bad screenshots before network use", async () => {
  await fixture(async (files) => {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error(CANARY); };
    await assert.rejects(runProbe({ ...files, fetchImpl, apiKey: CANARY }), checkError("live_required"));
    for (const apiKey of [undefined, "", "\nsecret", "x".repeat(4097)]) {
      await assert.rejects(runProbe({ ...files, fetchImpl, apiKey, live: true }), checkError("missing_key"));
    }
    await assert.rejects(runProbe({ ...files, screenshotPath: files.directory, fetchImpl, apiKey: CANARY, live: true }), checkError("invalid_image"));
    assert.equal(calls, 0);
  });
});

test("pending safety checks preserve a private review reason while the real probe remains blocked", async () => {
  await fixture(async (files) => {
    const explanation = "The screenshot contains potentially malicious instructions requiring review.";
    const result = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => Response.json(response([call({
      pending_safety_checks: [{ id: "opaque_check_id", code: "malicious_instructions", message: explanation }],
    })])) });
    assert.equal(result.summary.outcome, "safety_review_required");
    assert.equal(result.summary.click, undefined);
    assert.deepEqual(result.summary.safetyReview, { count: 1, codes: ["malicious_instructions"] });
    const review = JSON.parse(await readFile(path.join(files.evidenceRoot, result.runId, "safety-review.json"), "utf8"));
    assert.equal(review.source_tag, "tool");
    assert.equal(review.untrusted, true);
    assert.equal(review.checks[0].code, "malicious_instructions");
    assert.equal(review.checks[0].explanation, explanation);
    assert.ok(!JSON.stringify(review).includes("opaque_check_id"));
    assert.ok(!JSON.stringify(result.summary).includes(explanation));
  });
});

test("private safety explanations withhold credential patterns and keep unknown codes out of general evidence", async () => {
  await fixture(async (files) => {
    for (const message of [CANARY, Buffer.from(CANARY).toString("base64"), `Bearer ${"OTHER_SECRET_".repeat(4)}`,
      "api_key=OTHER_SECRET_VALUE", CANARY.slice(0, 10) + "\u001b[31m" + CANARY.slice(10)]) {
      const result = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => Response.json(response([call({
        pending_safety_checks: [{ id: CANARY, code: "custom_provider_review", message }],
      })])) });
      assert.equal(result.summary.outcome, "safety_review_required");
      assert.deepEqual(result.summary.safetyReview.codes, ["unknown_check"]);
      assert.ok(!JSON.stringify(result).includes("custom_provider_review"));
      const text = await readFile(path.join(files.evidenceRoot, result.runId, "safety-review.json"), "utf8");
      const review = JSON.parse(text);
      assert.equal(review.checks[0].explanationStatus, "withheld");
      assert.equal(review.checks[0].code, "custom_provider_review");
      assert.doesNotMatch(text, /SYNTHETIC_META|OTHER_SECRET|opaque_check/);
    }
    const result = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => Response.json(response([call({
      pending_safety_checks: [{ id: "check", code: CANARY, message: "Safe warning.\u0007" + "x".repeat(2000) }],
    })])) });
    const review = JSON.parse(await readFile(path.join(files.evidenceRoot, result.runId, "safety-review.json"), "utf8"));
    assert.equal(review.checks[0].code, "unknown_check");
    assert.equal(review.checks[0].explanation.length, 1024);
    assert.ok(!review.checks[0].explanation.includes("\u0007"));
  });
});

test("documented opaque safety identifiers are not rejected by an invented 128-character limit", async () => {
  await fixture(async (files) => {
    for (const id of ["", "opaque".repeat(100)]) {
      const result = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => Response.json(response([call({
        pending_safety_checks: [{ id, code: "malicious_instructions", message: "Review the proposed click." }],
      })])) });
      assert.equal(result.summary.outcome, "safety_review_required");
      assert.equal(result.summary.click, undefined);
      const review = JSON.parse(await readFile(path.join(files.evidenceRoot, result.runId, "safety-review.json"), "utf8"));
      assert.equal(review.checks[0].explanation, "Review the proposed click.");
      assert.ok(!JSON.stringify(review).includes("opaqueopaque"));
    }
  });
});

test("malformed safety metadata is invalid rather than a reviewable or accepted action", async () => {
  await fixture(async (files) => {
    for (const checks of [undefined, null, [null], [{}], [{ id: "check", message: 12 }]]) {
      const result = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => Response.json(response([call({ pending_safety_checks: checks })])) });
      assert.equal(result.summary.outcome, "invalid_response");
      assert.equal(result.summary.safetyReview, undefined);
      assert.equal(result.reviewFile, undefined);
      assert.equal(result.summary.actionShape.calls[0].safetyShape.valid, false);
      assert.deepEqual(await readdir(path.join(files.evidenceRoot, result.runId)), ["result.json"]);
    }
  });
});

test("a screenshot call without a replay receipt stops before continuation", async () => {
  await fixture(async (files) => {
    let requests = 0;
    const result = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => {
      requests++;
      return Response.json(response([call({ actions: [{ type: "screenshot" }], pending_safety_checks: [] })]));
    } });
    assert.equal(result.summary.outcome, "replay_unavailable");
    assert.equal(result.summary.replayReason, "missing_receipt");
    assert.equal(result.summary.click, undefined);
    assert.equal(result.reviewFile, undefined);
    assert.equal(result.summary.executed, false);
    assert.equal(requests, 1);
  });
});

test("stateless replay keeps genuine call and reasoning bytes unchanged and rejects malformed material", () => {
  const initial = buildRequest(instant);
  const original = response([{ type: "reasoning", id: "r_test", summary: [], encrypted_content: "unchanged-encrypted" },
    observation({ action: { type: "screenshot" } })]);
  const before = JSON.stringify(original);
  const next = buildContinuation(initial, original, { bytes: png() }, instant);
  assert.deepEqual(next.input.slice(1, -1), original.output);
  assert.equal(JSON.stringify(original), before);
  assert.equal(next.store, false);
  assert.equal(next.previous_response_id, undefined);
  assert.deepEqual(next.input.at(-1).acknowledged_safety_checks, []);
  for (const extra of [undefined, "", "x".repeat(8193), 7]) {
    assert.throws(() => buildContinuation(initial, response([observation({ meta_safety_replay_receipt: extra })]), { bytes: png() }),
      (error) => ["replay_unavailable", "invalid_response"].includes(error.code));
  }
  assert.throws(() => buildContinuation(initial, response([observation({ action: call().actions[0] })]), { bytes: png() }), checkError("invalid_action"));
  assert.throws(() => buildContinuation(initial, response([{ type: "reasoning", id: "r", summary: [], unknown: CANARY }, observation()]), { bytes: png() }), checkError("replay_unavailable"));
});

test("protocol stops on premature clicks, repeated observation, review, budget and replay-secret failures", async () => {
  await fixture(async (files) => {
    const cases = [
      [[response()], "premature_click", 1],
      [[response([observation()]), response([observation()])], "observation_requested", 2],
      [[response([observation()]), response([call({ pending_safety_checks: [{ id: "check", message: "Review the action." }] })])], "safety_review_required", 2],
      [[response([observation()]), response([call({ pending_safety_checks: null })])], "invalid_response", 2],
      [[response([observation()], { usage: undefined })], "token_budget_exceeded", 1],
      [[response([observation()], { usage: { input_tokens: 300, output_tokens: 513 } })], "token_budget_exceeded", 1],
      [[response([observation()], { usage: { input_tokens: 300, output_tokens: 40, output_tokens_details: { reasoning_tokens: 41 } } })], "token_budget_exceeded", 1],
      [[response([observation()]), response([call()], { usage: { input_tokens: 300, output_tokens: 600 } })], "token_budget_exceeded", 2],
      [[response([observation({ meta_safety_replay_receipt: CANARY })])], "replay_unavailable", 1],
    ];
    for (const [replies, expected, count] of cases) {
      let requests = 0;
      const result = await runProbe({ ...files, apiKey: CANARY, live: true,
        fetchImpl: async () => { assert.ok(requests < replies.length, "never retry"); return Response.json(replies[requests++]); } });
      assert.equal(result.summary.outcome, expected);
      assert.equal(result.summary.requestCount, count);
      assert.equal(requests, count);
      assert.equal(result.summary.click, undefined);
      if (expected === "replay_unavailable") assert.equal(result.summary.replayReason, "credential_in_replay");
      assert.ok(!JSON.stringify(result).includes(CANARY));
    }
  });
});

test("wall-clock budget stops before a second request even when the transport completes", async () => {
  await fixture(async (files) => {
    let elapsed = 0;
    let requests = 0;
    const result = await runProbe({ ...files, apiKey: CANARY, live: true, monotonicNow: () => elapsed,
      fetchImpl: async () => { requests++; elapsed = 45001; return Response.json(response([observation()])); } });
    assert.equal(result.summary.outcome, "timeout");
    assert.equal(requests, 1);
    assert.equal(result.summary.click, undefined);
  });
});

test("request deadline aborts a transport that ignores cancellation without a retry", async (context) => {
  await fixture(async (files) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let signal;
    let requests = 0;
    const probe = runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async (_, options) => {
      requests++; signal = options.signal; entered(); return new Promise(() => {});
    } });
    await started;
    context.mock.timers.tick(30000);
    const result = await probe;
    assert.equal(result.summary.outcome, "timeout");
    assert.equal(signal.aborted, true);
    assert.equal(requests, 1);
    context.mock.timers.reset();
  });
});

test("private review evidence refuses an existing destination without overwriting it", async () => {
  await fixture(async (files) => {
    let reviewPath;
    await assert.rejects(runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => {
      const [runId] = await readdir(files.evidenceRoot);
      reviewPath = path.join(files.evidenceRoot, runId, "safety-review.json");
      await writeFile(reviewPath, "preserve-existing-file");
      return Response.json(response([call({ pending_safety_checks: [{ id: "check", code: "malicious_instructions", message: "Review this screenshot." }] })]));
    } }), checkError("evidence_error"));
    assert.equal(await readFile(reviewPath, "utf8"), "preserve-existing-file");
  });
});

test("action diagnostics expose only bounded whitelisted structure and clearly unvalidated numeric click fields", () => {
  const unsafe = call({ actions: [{ type: "click", button: "left", x: 20, y: 15, text: CANARY, [CANARY]: CANARY, keys: null }] });
  const shape = describeResponse(response([unsafe]), { width: 64, height: 32 });
  assert.equal(shape.calls[0].actions[0].fields.text, "string");
  assert.equal(shape.calls[0].actions[0].unknownFieldCount, 1);
  assert.deepEqual(shape.calls[0].actions[0].unvalidatedClickFields, { type: "click", button: "left", x: 20, y: 15 });
  assert.ok(!JSON.stringify(shape).includes(CANARY));
  assert.throws(() => validateResponse(response([unsafe]), { width: 64, height: 32 }), checkError("invalid_action"));
});

test("two-stage mocked requests preserve replay and save exclusive evidence without credentials or raw output", async () => {
  await fixture(async (files) => {
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls++;
      assert.equal(url, ENDPOINT);
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, `Bearer ${CANARY}`);
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.ok(!options.body.includes(CANARY));
      if (calls % 2 === 1) {
        assert.equal(body.input.length, 1);
        return Response.json(response([{ type: "reasoning", id: "reasoning_id", summary: [], encrypted_content: "opaque-encrypted-state" }, observation()]));
      }
      assert.equal(body.input.at(-1).output.image_url, `data:image/png;base64,${png().toString("base64")}`);
      assert.equal(body.input.at(-1).call_id, "call_test");
      assert.equal(body.input.at(-2).meta_safety_replay_receipt, "genuine-test-fixture-receipt");
      assert.equal(body.input[1].encrypted_content, "opaque-encrypted-state");
      return Response.json(response([call({ id: CANARY })], {
        usage: { input_tokens: 300, output_tokens: 40, input_tokens_details: { cached_tokens: 50 },
          output_tokens_details: { reasoning_tokens: 20 }, untrusted_field: CANARY },
      }));
    };
    const first = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl, now: instant });
    const second = await runProbe({ ...files, apiKey: CANARY, live: true, fetchImpl, now: instant });
    assert.equal(calls, 4, "two protocol requests per explicit invocation");
    assert.notEqual(first.runId, second.runId);
    for (const result of [first, second]) {
      assert.equal(result.summary.outcome, "validated_click");
      assert.equal(result.summary.mode, "mock");
      assert.equal(result.summary.executed, false);
      assert.equal(result.summary.targetConfirmed, false);
      assert.deepEqual(result.summary.usage, { inputTokens: 600, outputTokens: 80, cachedInputTokens: 50, reasoningTokens: 20 });
      assert.equal(result.summary.requestCount, 2);
      const folder = path.join(files.evidenceRoot, result.runId);
      assert.deepEqual(await readdir(folder), ["result.json"]);
      const evidence = await readFile(path.join(folder, "result.json"), "utf8");
      assert.doesNotMatch(evidence, /SYNTHETIC_META|Authorization|base64|"reasoning"\s*:|encrypted_content|screen\.png/);
      assert.doesNotMatch(evidence, /genuine-test-fixture-receipt|opaque-encrypted-state|reasoning_id|call_test/);
      assert.deepEqual(JSON.parse(evidence), result.summary);
    }
  });
});

test("HTTP, timeout, malformed output, pending safety and bounded response failures are redacted without retries", async () => {
  await fixture(async (files) => {
    const scenarios = [
      [() => new Response(CANARY, { status: 401 }), "http_error"],
      [() => new Response(CANARY, { status: 429 }), "http_error"],
      [() => new Response(CANARY, { status: 302, headers: { location: "https://example.test" } }), "http_error"],
      [() => { throw new Error(CANARY); }, "network_error"],
      [() => { throw new DOMException(CANARY, "TimeoutError"); }, "timeout"],
      [() => new Response(CANARY), "invalid_response"],
      [() => Response.json(response([], { status: "incomplete", incomplete_details: { reason: CANARY } })), "incomplete_response"],
      [() => Response.json(response([call({ pending_safety_checks: [{ id: "pending", message: CANARY }] })])), "safety_review_required"],
      [() => new Response(CANARY, { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }), "response_too_large"],
      [() => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)), "response_too_large"],
    ];
    for (const [makeResponse, outcome] of scenarios) {
      let calls = 0;
      const result = await runProbe({ ...files, apiKey: CANARY, live: true,
        fetchImpl: async () => { calls++; return makeResponse(); } });
      assert.equal(calls, 1);
      assert.equal(result.summary.outcome, outcome);
      assert.equal(result.summary.click, undefined);
      assert.ok(!JSON.stringify(result).includes(CANARY));
      assert.ok(!safeError(new ProbeError(outcome)).includes(CANARY));
    }
  });
});

test("evidence paths refuse symlink/junction ancestors before any request", async () => {
  await fixture(async (files) => {
    const outside = path.join(files.directory, "outside");
    await mkdir(outside);
    await symlink(outside, files.evidenceRoot, process.platform === "win32" ? "junction" : "dir");
    let calls = 0;
    await assert.rejects(runProbe({ ...files, apiKey: CANARY, live: true,
      fetchImpl: async () => { calls++; return Response.json(response()); } }), checkError("evidence_error"));
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(outside), []);
  });
});

test("CLI help and failed preflight do not expose argument/env credentials or make a live request", async () => {
  await fixture(async (files) => {
    const env = { ...process.env, MODEL_API_KEY: CANARY };
    const run = (args, extraEnv = env) => spawnSync(process.execPath, ["--conditions=react-server", cli, ...args], {
      cwd: files.directory, env: extraEnv, encoding: "utf8", timeout: 10000,
    });
    const help = spawnSync(process.execPath, [cli, "--help"], {
      cwd: files.directory, env, encoding: "utf8", timeout: 10000,
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
    for (const args of [[], ["--api-key", CANARY], ["--screenshot", CANARY], ["--live", "--screenshot", CANARY]]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(CANARY));
    }
    const noKeyEnv = { ...env }; delete noKeyEnv.MODEL_API_KEY;
    const missing = run(["--live", "--screenshot", files.screenshotPath], noKeyEnv);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Set MODEL_API_KEY privately/);
  });
});
