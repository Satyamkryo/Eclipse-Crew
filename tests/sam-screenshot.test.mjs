import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { buildSamRequest, ENDPOINT, MAX_MASK_PIXELS, MAX_RESPONSE_BYTES, MODEL, renderMaskPng, runSamProbe,
  SamError, validateSamResponse } from "../scripts/spikes/sam-screenshot-core.mjs";
import { validatePng } from "../scripts/spikes/meta-computer-use-core.mjs";

const CANARY = "SYNTHETIC_SAM_CREDENTIAL_CANARY";
const image = { width: 64, height: 32 };
// Deterministic one_bit conformance rasters (4x3): solid, diagonal and empty.
const solid = "!!!!!'y7K#I-=";
const diagonal = "!!!!!'O@:^VtL";
const empty = "!!!!!&!!!!!";
function wire({ id = 0, payload = solid, x = 10, y = 12, width = 4, height = 3, source = image } = {}) {
  return `<0f>${id}<|box;x1=${x};y1=${y};x2=${x + width - 1};y2=${y + height - 1};w=${source.width};h=${source.height};c=0.9|><|mask;x=0;y=0;c=0.9;data=${height},${width},${payload}|>`;
}
function response(text = wire(), extra = {}) { return { model: MODEL, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], ...extra }; }
const checkError = (code) => (error) => error instanceof SamError && error.code === code;
async function fixture(fn) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(root, "eclipse-sam-test-"));
  const screenshotPath = path.join(directory, "screen.png");
  const source = renderMaskPng({ box: { x1: 0, y1: 0 }, width: 1, height: 1, raster: Uint8Array.of(1) }, image);
  await writeFile(screenshotPath, source);
  try { return await fn({ directory, screenshotPath, evidenceRoot: path.join(directory, "evidence"), source }); }
  finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith("eclipse-sam-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
}
function pngPixels(bytes) {
  let position = 8; const data = [];
  while (position < bytes.length) {
    const length = bytes.readUInt32BE(position);
    if (bytes.toString("ascii", position + 4, position + 8) === "IDAT") data.push(bytes.subarray(position + 8, position + 8 + length));
    position += length + 12;
  }
  return inflateSync(Buffer.concat(data));
}

test("SAM request sends one image and fixed concept, without Muse settings, replay or credentials", () => {
  const request = buildSamRequest({ bytes: Buffer.from("synthetic image") });
  assert.equal(request.model, "sam-3.1");
  assert.equal(request.store, false); assert.equal(request.stream, false);
  assert.deepEqual(request.metadata, { mask_encoding: "one_bit", include_confidence: "true" });
  assert.equal(request.input.length, 1); assert.equal(request.input[0].content[0].text, "button");
  assert.match(request.input[0].content[1].image_url, /^data:image\/png;base64,/);
  for (const name of ["tools", "reasoning", "previous_response_id", "max_output_tokens"]) assert.equal(request[name], undefined);
});

test("official decoder yields actual binary masks; PNG preserves source-pixel placement", () => {
  const objects = validateSamResponse(response(wire({ payload: diagonal })), image);
  assert.equal(objects.length, 1); assert.equal(objects[0].area, 3);
  assert.deepEqual([...objects[0].raster], [1,0,0,0,0,1,0,0,0,0,1,0]);
  const png = renderMaskPng(objects[0], image);
  assert.equal(validatePng(png).width, 64);
  const pixels = pngPixels(png);
  assert.equal(pixels[12 * 65 + 10 + 1], 255);
  assert.equal(pixels[13 * 65 + 11 + 1], 255);
  assert.equal(pixels[14 * 65 + 12 + 1], 255);
  assert.equal(pixels.reduce((sum, value) => sum + (value === 255 ? 1 : 0), 0), 3);
  assert.equal(validateSamResponse(response(), image)[0].area, 12);
});

test("completed zero matches is normal; malformed, incomplete and unsupported responses fail closed", () => {
  assert.deepEqual(validateSamResponse(response(""), image), []);
  assert.deepEqual(validateSamResponse({ model: MODEL, status: "completed", output: [] }, image), []);
  const cases = [
    [null, "invalid_response"], [response("", { model: "wrong" }), "invalid_response"],
    [response("", { status: "incomplete" }), "incomplete_response"],
    [response("", { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: CANARY }] }] }), "invalid_response"],
    [response("", { output: [...response().output, ...response().output] }), "invalid_response"],
  ];
  for (const [value, code] of cases) assert.throws(() => validateSamResponse(value, image), checkError(code));
});

test("preflight bounds every raster before parser allocation and rejects corrupt or ambiguous geometry", () => {
  const cases = [
    [wire().replace("<0f>", "<1f>"), "frame"],
    [wire().replace("w=64", "w=63"), "source_size"],
    [wire({ x: 63 }), "bounds"], [wire().replace("x1=10", "x1=-1"), "fields"],
    [wire().replace("data=3,4", "data=3,5"), "mask_size"],
    [wire().replace("c=0.9", "c=2"), "confidence"],
    [wire().replace("c=0.9", "c=0.8"), "confidence"],
    [wire().replace("data=3,4,!", "data=3,4,~"), "mask_encoding"],
    [wire({ payload: "!garbage" }), "parser_diagnostic"], [wire({ payload: empty }), "empty_mask"],
    [wire() + "," + wire().slice(4), "duplicate_id"],
    [wire() + CANARY, "grammar"], [wire().replace(";w=64", ";unknown=64"), "fields"],
    [wire().replace(";x2=13", ";x1=13"), "fields"],
  ];
  for (const [text, reason] of cases) {
    assert.throws(() => validateSamResponse(response(text), image), (error) => error.code === "invalid_segmentation" && error.reason === reason, reason);
  }
  const large = { width: 4096, height: 4096 };
  assert.ok(large.width * large.height > MAX_MASK_PIXELS);
  assert.throws(() => validateSamResponse(response(wire({ x: 0, y: 0, width: 4096, height: 4096, source: large })), large), (error) => error.reason === "pixel_limit");
  const many = "<0f>" + Array.from({ length: 65 }, (_, id) => wire({ id }).slice(4)).join(",");
  assert.throws(() => validateSamResponse(response(many), image), (error) => error.reason === "object_limit");
});

test("preflight rejects missing consent, key, image and unsafe evidence paths without network", async () => {
  await fixture(async (files) => {
    let requests = 0; const fetchImpl = async () => { requests++; throw Error(CANARY); };
    await assert.rejects(runSamProbe({ ...files, apiKey: CANARY, fetchImpl }), checkError("live_required"));
    for (const apiKey of [undefined, "", "\nsecret"]) await assert.rejects(runSamProbe({ ...files, apiKey, live: true, fetchImpl }), checkError("missing_key"));
    await assert.rejects(runSamProbe({ ...files, screenshotPath: files.directory, apiKey: CANARY, live: true, fetchImpl }), checkError("invalid_image"));
    const outside = path.join(files.directory, "outside"); await mkdir(outside);
    await symlink(outside, files.evidenceRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(runSamProbe({ ...files, apiKey: CANARY, live: true, fetchImpl }), checkError("evidence_error"));
    assert.equal(requests, 0); assert.deepEqual(await readdir(outside), []);
  });
});

test("one mocked request writes exclusive genuine decoded-mask evidence and sanitizes usage", async () => {
  await fixture(async (files) => {
    let requests = 0;
    const fetchImpl = async (url, options) => {
      requests++; assert.equal(url, ENDPOINT); assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, `Bearer ${CANARY}`);
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.equal(body.input[0].content[1].image_url, `data:image/png;base64,${files.source.toString("base64")}`);
      assert.ok(!options.body.includes(CANARY));
      return Response.json(response(wire(), { usage: { input_tokens: 20, output_tokens: 30, untrusted: "UNTRUSTED_PROVIDER_DATA" }, id: "opaque-response-id" }));
    };
    const first = await runSamProbe({ ...files, apiKey: CANARY, live: true, fetchImpl });
    const second = await runSamProbe({ ...files, apiKey: CANARY, live: true, fetchImpl });
    assert.equal(requests, 2); assert.notEqual(first.runId, second.runId);
    for (const result of [first, second]) {
      assert.equal(result.summary.outcome, "validated_masks"); assert.equal(result.summary.mode, "mock");
      assert.equal(result.summary.requestCount, 1); assert.equal(result.summary.targetConfirmed, false);
      assert.equal(result.summary.objects[0].area, 12);
      assert.deepEqual(result.summary.usage, { input_tokens: 20, output_tokens: 30 });
      const directory = path.join(files.evidenceRoot, result.runId);
      assert.deepEqual((await readdir(directory)).sort(), ["mask-0.png", "result.json"]);
      const text = await readFile(path.join(directory, "result.json"), "utf8");
      for (const value of [CANARY, solid, "opaque-response-id", "UNTRUSTED_PROVIDER_DATA", "base64", "screen.png"]) assert.ok(!text.includes(value));
      assert.equal(validatePng(await readFile(path.join(directory, "mask-0.png"))).height, 32);
    }
  });
});

test("HTTP/network/size/schema/decode failures never retry and never retain raw error or credential text", async () => {
  await fixture(async (files) => {
    const cases = [
      [() => new Response(CANARY, { status: 401 }), "http_error"],
      [() => new Response(CANARY, { status: 429 }), "http_error"],
      [() => new Response(CANARY, { status: 302 }), "http_error"],
      [() => { throw Error(CANARY); }, "network_error"],
      [() => new Response(CANARY), "invalid_response"],
      [() => new Response("", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }), "response_too_large"],
      [() => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)), "response_too_large"],
      [() => Response.json(response(wire(), { id: CANARY })), "invalid_response"],
      [() => Response.json(response(wire({ payload: "garbage" }))), "invalid_segmentation"],
      [() => Response.json(response("")), "no_matches"],
    ];
    for (const [makeResponse, expected] of cases) {
      let requests = 0;
      const result = await runSamProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => { requests++; return makeResponse(); } });
      assert.equal(requests, 1); assert.equal(result.summary.outcome, expected);
      assert.ok(!JSON.stringify(result).includes(CANARY));
      assert.deepEqual(await readdir(path.join(files.evidenceRoot, result.runId)), ["result.json"]);
    }
  });
});

test("30-second deadline aborts a non-cooperating transport without a retry", async (context) => {
  await fixture(async (files) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let entered; const started = new Promise((resolve) => { entered = resolve; }); let signal; let requests = 0;
    const probe = runSamProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async (_, options) => {
      requests++; signal = options.signal; entered(); return new Promise(() => {});
    } });
    await started; context.mock.timers.tick(30000); const result = await probe;
    assert.equal(result.summary.outcome, "timeout"); assert.equal(signal.aborted, true); assert.equal(requests, 1);
    context.mock.timers.reset();
  });
});

test("exclusive evidence refuses an existing result destination without overwriting it", async () => {
  await fixture(async (files) => {
    let destination;
    await assert.rejects(runSamProbe({ ...files, apiKey: CANARY, live: true, fetchImpl: async () => {
      const [id] = await readdir(files.evidenceRoot); destination = path.join(files.evidenceRoot, id, "result.json");
      await writeFile(destination, "preserve-existing-result"); return Response.json(response(""));
    } }), checkError("evidence_error"));
    assert.equal(await readFile(destination, "utf8"), "preserve-existing-result");
  });
});

test("CLI help and failed argument/key preflight reveal no secrets and make no request", async () => {
  await fixture(async (files) => {
    const cli = path.resolve(import.meta.dirname, "../scripts/spikes/sam-screenshot.mjs");
    const env = { ...process.env, MODEL_API_KEY: CANARY };
    const run = (args, customEnv = env) => spawnSync(process.execPath, ["--conditions=react-server", cli, ...args], { cwd: files.directory, env: customEnv, encoding: "utf8", timeout: 10000 });
    assert.equal(run(["--help"]).status, 0);
    for (const args of [[], ["--api-key", CANARY], ["--live", "--screenshot", CANARY]]) {
      const result = run(args); assert.equal(result.status, 1); assert.ok(!(result.stdout + result.stderr).includes(CANARY));
    }
    const missingEnv = { ...env }; delete missingEnv.MODEL_API_KEY;
    assert.equal(run(["--live", "--screenshot", files.screenshotPath], missingEnv).status, 1);
  });
});
