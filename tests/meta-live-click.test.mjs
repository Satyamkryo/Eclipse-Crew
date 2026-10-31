import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { buildLiveContinuation, buildLiveRequest, buildReviewedAcknowledgement, CONFIRMATION_CODE, REVIEW_TIMEOUT_MS, hash, validateViewportGeometry, LiveClickError, MODEL, runLiveClick } from "../scripts/spikes/meta-live-click-core.mjs";
import { minimalBrowserEnv, openLocalDriver, requestAllowed, waitForOwnerReview } from "../scripts/spikes/meta-live-click.mjs";
import { renderMaskPng } from "../scripts/spikes/sam-screenshot-core.mjs";

const CANARY = "SYNTHETIC_LIVE_CLICK_CREDENTIAL";
const bytes = renderMaskPng({ box: { x1: 0, y1: 0 }, width: 1, height: 1, raster: Uint8Array.of(1) }, { width: 64, height: 32 });
const geometry = { width: 64, height: 32, dpr: 1 };
const click = { type: "click", button: "left", x: 20, y: 15 };
function call(overrides = {}) { return { type: "computer_call", id: "cc-test", call_id: "call-test", status: "completed", actions: [click], pending_safety_checks: [], ...overrides }; }
function response(output = [call()], overrides = {}) { return { model: MODEL, status: "completed", output, usage: { input_tokens: 200, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 } }, ...overrides }; }
function mockDriver(options = {}) {
  let executions = 0;
  return { get executed() { return executions > 0; }, get clickAttempted() { return executions > 0; },
    capture: async () => ({ bytes, geometry, fingerprint: "stable" }),
    checkTarget: async () => ({ targetMatched: true, closedBefore: true }),
    execute: async (point) => {
      assert.deepEqual(point, click); executions++;
      if (options.deny) throw new LiveClickError(options.deny);
      return { closedBefore: true, openAfter: true, statusVisible: !options.failedPostcondition, bytes, geometry };
    }, ...options,
  };
}
async function fixture(fn) {
  const root = await realpath(tmpdir()); const directory = await mkdtemp(path.join(root, "eclipse-click-test-"));
  try { return await fn({ directory, evidenceRoot: path.join(directory, "evidence") }); }
  finally {
    const resolved = await realpath(directory); assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith("eclipse-click-test-")); await rm(resolved, { recursive: true, force: true });
  }
}
const errorCode = (code) => (error) => error.code === code;

test("original-detail images preserve pixels through initial, observation and reviewed acknowledgement", () => {
  const initial = buildLiveRequest(bytes);
  assert.match(initial.instructions, /64x32 pixels, origin \(0,0\)/);
  const observation = response([call({ actions: [{ type: "screenshot" }] })]);
  const next = buildLiveContinuation(initial, observation, bytes);
  const checks = [{ id: "test-check", code: CONFIRMATION_CODE, message: "Confirm" }];
  const native = response([call({ pending_safety_checks: checks })]);
  const ack = buildReviewedAcknowledgement(next, native, bytes, checks);
  for (const image of [initial.input[0].content[1], next.input.at(-1).output, ack.input.at(-1).output]) {
    assert.equal(image.detail, "original");
    assert.deepEqual(Buffer.from(image.image_url.split(",")[1], "base64"), bytes);
  }
  assert.deepEqual(ack.input.slice(0, next.input.length), next.input);
  assert.deepEqual(ack.input.slice(next.input.length, -1), native.output);
});

test("geometry mismatch rejects missing, scaled and mismatched screenshots before network or input", async () => {
  assert.deepEqual(validateViewportGeometry(bytes, geometry), geometry);
  for (const invalid of [undefined, { ...geometry, dpr: 2 }, { ...geometry, width: 128 }, { ...geometry, height: 33 }]) {
    assert.throws(() => validateViewportGeometry(bytes, invalid), errorCode("geometry_mismatch"));
    await fixture(async (files) => {
      let requests = 0;
      const driver = mockDriver({ capture: async () => ({ bytes, geometry: invalid, fingerprint: "stable" }) });
      const result = await runLiveClick({ ...files, driver, apiKey: CANARY, live: true,
        fetchImpl: async () => { requests++; throw Error("must not request"); } });
      assert.equal(result.summary.outcome, "geometry_mismatch");
      assert.equal(requests, 0); assert.equal(driver.executed, false);
    });
  }
});

test("model request supplies fresh pixels, fixed intent, Contributor model, clock and capped settings", () => {
  const request = buildLiveRequest(bytes, new Date("2026-10-30T00:00:00Z"));
  assert.equal(request.model, "muse-spark-1.3-contributor"); assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 1024); assert.equal(request.reasoning.effort, "low");
  assert.deepEqual(request.tools, [{ type: "computer" }]);
  assert.match(request.instructions, /2026-10-30T00:00:00.000Z.*Etc\/UTC/);
  assert.match(request.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.ok(!JSON.stringify(request).includes(CANARY));
});

test("stateless observation replay preserves genuine items unchanged, with and without optional receipt", () => {
  for (const receipt of [undefined, "genuine-receipt"]) {
    const native = response([{ type: "reasoning", id: "reasoning-id", summary: [], encrypted_content: "encrypted-state" },
      call({ actions: [{ type: "screenshot" }], ...(receipt ? { meta_safety_replay_receipt: receipt } : {}) })]);
    const before = JSON.stringify(native); const initial = buildLiveRequest(bytes);
    const next = buildLiveContinuation(initial, native, bytes);
    assert.deepEqual(next.input.slice(1, -1), native.output); assert.equal(JSON.stringify(native), before);
    assert.equal(next.input.at(-1).call_id, "call-test");
    assert.deepEqual(next.input.at(-1).acknowledged_safety_checks, []);
    assert.equal(next.input.at(-2).meta_safety_replay_receipt, receipt);
  }
  assert.throws(() => buildLiveContinuation(buildLiveRequest(bytes), response([call({ actions: [{ type: "screenshot" }], meta_safety_replay_receipt: "" })]), bytes), errorCode("invalid_response"));
});

test("documented assistant messages replay unchanged alongside reasoning and native observation calls", () => {
  const native = response([{ type: "message", id: "message-test", role: "assistant", status: "completed",
    phase: "commentary", content: [{ type: "output_text", text: "I will inspect the screen.", annotations: [] }] },
    { type: "reasoning", id: "reasoning-test", summary: [], encrypted_content: "opaque" },
    call({ actions: [{ type: "screenshot" }], meta_safety_replay_receipt: "genuine" })]);
  const next = buildLiveContinuation(buildLiveRequest(bytes), native, bytes);
  assert.deepEqual(next.input.slice(1, -1), native.output);
  const invalid = structuredClone(native); invalid.output[0].role = "developer";
  assert.throws(() => buildLiveContinuation(buildLiveRequest(bytes), invalid, bytes), (error) =>
    error.code === "replay_unavailable" && error.replayDiagnostic.itemType === "message");
});

test("one native click is executed once and verified, with exclusive redacted mock evidence", async () => {
  await fixture(async (files) => {
    let requests = 0; const driver = mockDriver();
    const result = await runLiveClick({ ...files, driver, apiKey: CANARY, live: true, fetchImpl: async (_, options) => {
      requests++; assert.equal(options.headers.Authorization, `Bearer ${CANARY}`); assert.equal(options.redirect, "error");
      assert.ok(!options.body.includes(CANARY)); return Response.json(response());
    } });
    assert.equal(requests, 1); assert.equal(result.summary.mode, "mock");
    assert.equal(result.summary.outcome, "verified_click"); assert.equal(result.summary.executed, true);
    assert.equal(result.summary.clickCount, 1); assert.equal(result.summary.postconditions.openAfter, true);
    assert.deepEqual((await readdir(path.join(files.evidenceRoot, result.runId))).sort(), ["after.png", "before.png", "result.json"]);
    const text = await readFile(path.join(files.evidenceRoot, result.runId, "result.json"), "utf8");
    assert.doesNotMatch(text, /SYNTHETIC|base64|call-test|cc-test/);
  });
});

test("a screenshot observation can continue once, then execute only the genuine click", async () => {
  await fixture(async (files) => {
    let requests = 0;
    const result = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true, fetchImpl: async (_, options) => {
      requests++;
      if (requests === 1) return Response.json(response([call({ actions: [{ type: "screenshot" }] })]));
      const body = JSON.parse(options.body); assert.equal(body.input.at(-1).call_id, "call-test");
      return Response.json(response());
    } });
    assert.equal(requests, 2); assert.equal(result.summary.outcome, "verified_click");
    assert.equal(result.summary.usage.outputTokens, 80); assert.equal(result.summary.clickCount, 1);
  });
});

test("a click whose postcondition fails is reported as executed but never as success", async () => {
  await fixture(async (files) => {
    const result = await runLiveClick({ ...files, driver: mockDriver({ failedPostcondition: true }), apiKey: CANARY, live: true,
      fetchImpl: async () => Response.json(response()) });
    assert.equal(result.summary.outcome, "postcondition_failed"); assert.equal(result.summary.executed, true);
    assert.equal(result.summary.clickCount, 1); assert.equal(result.summary.requestCount, 1);
    assert.equal(result.summary.postconditions.statusVisible, false);
  });
});

test("replay failures retain the rejected item and schema field; unknown provider fields are preserved", async () => {
  await fixture(async (files) => {
    const result = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true,
      fetchImpl: async () => Response.json(response([
        { type: "reasoning", id: "test", summary: null }, call({ actions: [{ type: "screenshot" }] }),
      ])) });
    assert.equal(result.summary.outcome, "replay_unavailable");
    assert.equal(result.summary.replayDiagnostic.itemType, "reasoning");
    assert.deepEqual(result.summary.replayDiagnostic.issues[0].path, ["summary"]);
    assert.equal(result.summary.requestCount, 1); assert.equal(result.summary.executed, false);
    // Unknown provider fields are preserved in replay (passthrough), not rejected.
    // Credential content in unknown fields is caught by the body-credential check in runLiveClick.
    const continuation = buildLiveContinuation(buildLiveRequest(bytes), response([
      call({ actions: [{ type: "screenshot" }], extra_provider_field: "opaque" })]), bytes);
    assert.equal(continuation.input[1].extra_provider_field, "opaque");
    const original = response([{ type: "reasoning", id: "reasoning", summary: [], provider_metadata: { version: 2 } },
      call({ actions: [{ type: "screenshot" }], extra_provider_field: "opaque", meta_safety_replay_receipt: "signed-receipt" })]);
    const replayed = buildLiveContinuation(buildLiveRequest(bytes), original, bytes);
    assert.deepEqual(replayed.input.slice(1, -1), original.output);
    const credResult = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true,
      fetchImpl: async () => Response.json(response([
        call({ actions: [{ type: "screenshot" }], leaked: CANARY }),
      ])) });
    assert.equal(credResult.summary.outcome, "invalid_response");
    assert.equal(credResult.summary.reason, "credential_in_output");
    assert.equal(credResult.summary.executed, false);
  });
});

test("unsafe actions, malformed metadata, exhausted budgets and transport errors never execute or retry", async () => {
  await fixture(async (files) => {
    const cases = [
      [() => Response.json(response([call({ pending_safety_checks: null })])), "invalid_response"],
      [() => Response.json(response([call({ actions: [click, click] })])), "invalid_action"],
      [() => Response.json(response([call({ actions: [{ ...click, button: "right" }] })])), "invalid_action"],
      [() => Response.json(response([call({ actions: [{ ...click, x: 64 }] })])), "out_of_bounds"],
      [() => Response.json(response([], { status: "incomplete" })), "incomplete_response"],
      [() => Response.json(response([call()], { usage: { input_tokens: 10, output_tokens: 1025 } })), "token_budget"],
      [() => Response.json(response([call()], { usage: undefined })), "token_budget"],
      [() => new Response(CANARY, { status: 401 }), "http_error"],
      [() => new Response(CANARY, { status: 429 }), "http_error"],
      [() => new Response(CANARY), "invalid_response"],
      [() => Response.json(null), "invalid_response"],
      [() => { throw Error(CANARY); }, "network_error"],
    ];
    for (const [reply, expected] of cases) {
      let requests = 0; const driver = mockDriver();
      const result = await runLiveClick({ ...files, driver, apiKey: CANARY, live: true, fetchImpl: async () => { requests++; return reply(); } });
      assert.equal(requests, 1); assert.equal(result.summary.outcome, expected);
      assert.equal(result.summary.executed, false); assert.ok(!JSON.stringify(result).includes(CANARY));
    }
    let requests = 0;
    const repeated = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true,
      fetchImpl: async () => { requests++; return Response.json(response([call({ actions: [{ type: "screenshot" }] })])); } });
    assert.equal(requests, 2); assert.equal(repeated.summary.reason, "repeated_observation"); assert.equal(repeated.summary.executed, false);
  });
});

test("pending checks stop input and preserve only sanitized private review explanations", async () => {
  await fixture(async (files) => {
    for (const message of ["Review this reversible click.", CANARY, `Bearer ${CANARY}`]) {
      const result = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true,
        fetchImpl: async () => Response.json(response([call({ pending_safety_checks: [{ id: "opaque-check", code: "review", message }] })])) });
      assert.equal(result.summary.outcome, "safety_review_required"); assert.equal(result.summary.executed, false);
      const text = await readFile(path.join(files.evidenceRoot, result.runId, "safety-review.json"), "utf8");
      assert.doesNotMatch(text, /SYNTHETIC|opaque-check/);
      assert.equal(JSON.parse(text).untrusted, true);
      assert.ok(!JSON.stringify(result.summary).includes(message));
    }
  });
});

test("preflight rejects consent/key/evidence errors before network or capture", async () => {
  await fixture(async (files) => {
    let requests = 0; const args = { ...files, driver: mockDriver(), apiKey: CANARY, fetchImpl: async () => { requests++; throw Error(); } };
    await assert.rejects(runLiveClick(args), errorCode("live_required"));
    await assert.rejects(runLiveClick({ ...args, live: true, apiKey: "" }), errorCode("missing_key"));
    const outside = path.join(files.directory, "outside"); await mkdir(outside);
    await symlink(outside, files.evidenceRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(runLiveClick({ ...args, live: true }), errorCode("evidence_error"));
    assert.equal(requests, 0);
  });
});

const confirmationChecks = [{ id: "private-check-handle", code: CONFIRMATION_CODE, message: "Review and confirm this computer action." }];
test("reviewed click replays exact checks, genuine receipt and after-image; no third action is executed", async () => {
  await fixture(async (files) => {
    let requests = 0; let reviews = 0;
    const driver = mockDriver();
    const native = response([call({ pending_safety_checks: confirmationChecks, meta_safety_replay_receipt: "genuine-receipt" })]);
    const beforeNative = JSON.stringify(native);
    const result = await runLiveClick({ ...files, driver, apiKey: CANARY, live: true,
      confirmAction: async (info) => { reviews++; assert.equal(driver.executed, false); assert.equal(info.targetMatched, true); return true; },
      fetchImpl: async (_, options) => {
        requests++;
        if (requests === 1) return Response.json(response([call({ actions: [{ type: "screenshot" }] })], { usage: { input_tokens: 200, output_tokens: 1024 } }));
        if (requests === 2) return Response.json({ ...native, usage: { input_tokens: 200, output_tokens: 1024 } });
        assert.equal(driver.executed, true);
        const body = JSON.parse(options.body);
        assert.deepEqual(body.input.at(-1).acknowledged_safety_checks, confirmationChecks);
        assert.equal(body.input.at(-1).call_id, "call-test");
        assert.equal(body.input.at(-2).meta_safety_replay_receipt, "genuine-receipt");
        assert.equal(body.input.at(-1).output.image_url, `data:image/png;base64,${bytes.toString("base64")}`);
        return Response.json(response([call()], { usage: { input_tokens: 200, output_tokens: 1024 } }));
      } });
    assert.equal(requests, 3); assert.equal(reviews, 1); assert.equal(result.summary.maxRequests, 3);
    assert.equal(result.summary.maxTotalOutputTokens, 3072); assert.equal(result.summary.reviewApproved, true);
    assert.equal(result.summary.usage.outputTokens, 3072);
    assert.equal(result.summary.outcome, "verified_click"); assert.equal(result.summary.acknowledgement, "accepted");
    assert.equal(result.summary.clickCount, 1); assert.equal(result.summary.furtherActionsExecuted, false);
    assert.equal(JSON.stringify(native), beforeNative);
    assert.ok(!JSON.stringify(result).includes("private-check-handle"));
    assert.ok(!JSON.stringify(result).includes("genuine-receipt"));
    assert.throws(() => buildReviewedAcknowledgement(buildLiveRequest(bytes), native, bytes, []), errorCode("safety_review_required"));
  });
});

test("wrong targets and review denial never execute or acknowledge, and stale state after review stops", async () => {
  await fixture(async (files) => {
    for (const scenario of ["wrong_target", "review_denied", "stale_page"]) {
      let reviews = 0; let requests = 0;
      const driver = mockDriver({
        checkTarget: async () => { if (scenario === "wrong_target") throw new LiveClickError("wrong_target"); },
        execute: async () => { throw new LiveClickError("stale_page"); },
      });
      const result = await runLiveClick({ ...files, driver, apiKey: CANARY, live: true,
        confirmAction: async () => { reviews++; return scenario !== "review_denied"; },
        fetchImpl: async () => { requests++; return Response.json(response([call({ pending_safety_checks: confirmationChecks })])); } });
      assert.equal(result.summary.outcome, scenario); assert.equal(requests, 1);
      assert.equal(reviews, scenario === "wrong_target" ? 0 : 1);
      assert.equal(result.summary.executed, false); assert.equal(result.summary.acknowledgement, "not_required");
    }
  });
});

test("acknowledgement failure preserves a genuinely executed click and verified postcondition", async () => {
  await fixture(async (files) => {
    let requests = 0;
    const result = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true,
      confirmAction: async () => true, fetchImpl: async () => {
        requests++; return requests === 1 ? Response.json(response([call({ pending_safety_checks: confirmationChecks })])) : new Response("failed", { status: 400 });
      } });
    assert.equal(requests, 2); assert.equal(result.summary.executed, true); assert.equal(result.summary.clickCount, 1);
    assert.equal(result.summary.postconditions.openAfter, true); assert.equal(result.summary.acknowledgement, "failed");
    assert.equal(result.summary.outcome, "http_error");
  });
});

test("review deadline never turns silence into approval and is excluded from model time", async (context) => {
  await fixture(async (files) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let entered; const started = new Promise((resolve) => { entered = resolve; });
    const probe = runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true,
      confirmAction: async () => { entered(); return new Promise(() => {}); },
      fetchImpl: async () => Response.json(response([call({ pending_safety_checks: confirmationChecks })])) });
    await started; context.mock.timers.tick(REVIEW_TIMEOUT_MS); const result = await probe;
    assert.equal(result.summary.outcome, "review_timeout"); assert.equal(result.summary.executed, false);
    context.mock.timers.reset();
    let time = 0; let requests = 0;
    const approved = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true, monotonicNow: () => time,
      confirmAction: async () => { time += 250000; return true; },
      fetchImpl: async () => { requests++; time += 100; return Response.json(requests === 1 ? response([call({ pending_safety_checks: confirmationChecks })]) : response([])); } });
    assert.equal(approved.summary.outcome, "verified_click"); assert.equal(approved.summary.activeModelMs, 200);
    assert.equal(approved.summary.reviewWaitMs, 250000);
  });
});

test("stdin owner review is nonce-bound, explicit, single-use and abortable", async () => {
  for (const decision of ["approve", "wrong-token", "deny", "abort"]) {
    const input = new PassThrough(); const controller = new AbortController();
    let event;
    const result = waitForOwnerReview({ signal: controller.signal, runId: "test", click, code: CONFIRMATION_CODE,
      explanation: "Review this action.", targetMatched: true, beforeSha256: hash(bytes) }, { input, emit: (value) => { event = value; } });
    assert.equal(event.event, "owner_review_required"); assert.ok(event.reviewToken);
    if (decision === "abort") controller.abort();
    else input.write(decision === "approve" ? `APPROVE ${event.reviewToken}\n` : decision === "deny" ? `DENY ${event.reviewToken}\n` : "APPROVE wrong\n");
    assert.equal(await result, decision === "approve"); input.destroy();
  }
});

test("30-second request timeout aborts a non-cooperating transport without input", async (context) => {
  await fixture(async (files) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let entered; const started = new Promise((resolve) => { entered = resolve; }); let signal;
    const probe = runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true,
      fetchImpl: async (_, options) => { signal = options.signal; entered(); return new Promise(() => {}); } });
    await started; context.mock.timers.tick(30000); const result = await probe;
    assert.equal(result.summary.outcome, "timeout"); assert.equal(result.summary.executed, false); assert.equal(signal.aborted, true);
    context.mock.timers.reset();
  });
});

test("a total budget overrun and stale observation stop before another model request", async () => {
  await fixture(async (files) => {
    let time = 0; let requests = 0;
    const result = await runLiveClick({ ...files, driver: mockDriver(), apiKey: CANARY, live: true, monotonicNow: () => time,
      fetchImpl: async () => { requests++; time = 45001; return Response.json(response()); } });
    assert.equal(result.summary.outcome, "timeout"); assert.equal(requests, 1); assert.equal(result.summary.executed, false);
    let captures = 0;
    const stale = await runLiveClick({ ...files, driver: mockDriver({ capture: async () => ({ bytes, geometry, fingerprint: captures++ ? "changed" : "stable" }) }), apiKey: CANARY, live: true,
      fetchImpl: async () => Response.json(response([call({ actions: [{ type: "screenshot" }] })])) });
    assert.equal(stale.summary.outcome, "stale_page"); assert.equal(stale.summary.requestCount, 1);
  });
});

test("request policy denies foreign pages, credentials, writes, assets-as-navigation and arbitrary local routes", () => {
  assert.equal(requestAllowed("http://127.0.0.1:3000/", "GET", true), true);
  assert.equal(requestAllowed("http://127.0.0.1:3000/_next/static/test.js", "GET", false), true);
  for (const [url, method, navigation] of [["https://example.com/", "GET", true], ["http://127.0.0.1:3000/login", "GET", true],
    ["http://user:password@127.0.0.1:3000/", "GET", true], ["http://127.0.0.1:3000/", "POST", false],
    ["http://127.0.0.1:3000/_next/static/test.js", "GET", true], ["http://127.0.0.1:3000/api/secrets", "GET", false]]) {
    assert.equal(requestAllowed(url, method, navigation), false);
  }
  const env = minimalBrowserEnv("E:\\private-test", { SystemRoot: "C:\\Windows", MODEL_API_KEY: CANARY, DATABASE_URL: CANARY });
  assert.ok(!JSON.stringify(env).includes(CANARY)); assert.equal(env.USERPROFILE, "E:\\private-test");
});

test("real isolated browser rejects wrong/stale points and executes only one permitted coordinate click without a model", async () => {
  const driver = await openLocalDriver();
  try {
    const before = await driver.capture(); const box = before.targetBox;
    assert.deepEqual(before.geometry, { width: 1280, height: 800, dpr: 1 });
    const point = { type: "click", button: "left", x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) };
    await assert.rejects(driver.execute({ ...point, x: 0, y: 0 }, before), errorCode("wrong_target"));
    await assert.rejects(driver.execute(point, { ...before, fingerprint: "stale" }), errorCode("stale_page"));
    assert.equal(driver.executed, false);
    const after = await driver.execute(point, before);
    assert.deepEqual([after.closedBefore, after.openAfter, after.statusVisible], [true, true, true]);
    assert.equal(driver.executed, true); assert.notEqual(hash(after.bytes), hash(before.bytes));
    await assert.rejects(driver.execute(point, before), errorCode("click_limit"));
  } finally { await driver.close(); }
});

test("CLI help/invalid arguments never load a browser or reveal a supplied credential", () => {
  const cli = path.resolve(import.meta.dirname, "../scripts/spikes/meta-live-click.mjs");
  const run = (args) => spawnSync(process.execPath, ["--conditions=react-server", cli, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, MODEL_API_KEY: CANARY } });
  assert.equal(run(["--help"]).status, 0);
  const result = run(["--api-key", CANARY]); assert.equal(result.status, 1); assert.ok(!(result.stdout + result.stderr).includes(CANARY));
});
