import "server-only";

import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { decodeMaskToRaster, formats, recordsOfKind } from "@meta-sam/parser";
import { z } from "zod";
import { readScreenshot } from "./meta-computer-use-core.mjs";

export const MODEL = "sam-3.1";
export const ENDPOINT = "https://api.meta.ai/v1/responses";
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_MASK_PIXELS = 16_000_000;
export const TIMEOUT_MS = 30000;
const MAX_OBJECTS = 64;
const messages = {
  live_required: "Add --live to explicitly enable the single-image SAM probe.",
  invalid_arguments: "Use --screenshot <safe PNG path> --live; keys are accepted only through the private environment.",
  missing_key: "Set MODEL_API_KEY privately in .env.local, .env or the shell.",
  invalid_image: "Select a regular valid PNG at most 5 MiB and 4096 pixels per side.",
  configuration_error: "Could not load private configuration.",
  invalid_response: "The provider response did not match the segmentation protocol.",
  incomplete_response: "The provider response was not completed; no mask was accepted.",
  invalid_segmentation: "The segmentation geometry or mask was invalid.",
  no_matches: "SAM returned no matching objects; target proof remains incomplete.",
  http_error: "Meta returned an HTTP error; no retry was made.",
  network_error: "The Meta request failed; no retry was made.",
  timeout: "The SAM request exceeded 30 seconds; no retry was made.",
  response_too_large: "The SAM response exceeded 8 MiB.",
  evidence_error: "Could not reserve or write exclusive private evidence safely.",
};
const reasons = new Set(["schema", "unsupported_output", "multiple_text_lanes", "frame", "grammar", "object_limit", "duplicate_id", "fields", "source_size", "bounds", "confidence", "mask_size", "mask_encoding", "pixel_limit", "parser_diagnostic", "decode_failed", "empty_mask", "credential_in_output"]);
export class SamError extends Error {
  constructor(code, reason) {
    super(messages[code] ?? messages.invalid_response);
    this.code = Object.hasOwn(messages, code) ? code : "invalid_response";
    if (reasons.has(reason)) this.reason = reason;
  }
}
export function safeSamError(error) { return error instanceof SamError ? error.message : "SAM probe failed safely; raw diagnostics were withheld."; }
const fail = (reason) => { throw new SamError("invalid_segmentation", reason); };

export function buildSamRequest(image) {
  return { model: MODEL, store: false, stream: false,
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "button" },
      { type: "input_image", image_url: `data:image/png;base64,${image.bytes.toString("base64")}` },
    ] }],
  };
}

const envelope = z.object({ model: z.literal(MODEL), status: z.string(), output: z.array(z.object({
  type: z.literal("message"), role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("output_text"), text: z.string().max(MAX_RESPONSE_BYTES) })).max(16),
})).max(16) });
const count = z.number().int().nonnegative().max(1_000_000_000);
const usageSchema = z.object({ input_tokens: count.optional(), output_tokens: count.optional(),
  images: count.optional(), image_count: count.optional(), video_frames_processed: count.optional() });
const kind = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
function responseShape(value) {
  return { modelMatches: value?.model === MODEL,
    status: ["completed", "incomplete", "failed", "cancelled"].includes(value?.status) ? value.status : "unknown",
    outputKind: kind(value?.output), outputCount: Array.isArray(value?.output) ? value.output.length : null,
    itemTypes: Array.isArray(value?.output) ? value.output.slice(0, 4).map((item) => ["message", "reasoning", "computer_call"].includes(item?.type) ? item.type : "unknown") : [],
  };
}
function schemaDiagnostics(error) {
  const fields = new Set(["model", "status", "output", "type", "role", "content", "text"]);
  return error.issues.slice(0, 8).map((issue) => ({
    code: ["invalid_type", "invalid_value", "too_big", "too_small"].includes(issue.code) ? issue.code : "schema_error",
    path: issue.path.slice(0, 5).map((part) => Number.isInteger(part) && part >= 0 && part <= 16 ? part : fields.has(part) ? part : "unknown_field"),
  }));
}

// The official parser decodes masks during parsing. Preflight the complete wire
// grammar and allocation dimensions first; never let an unbounded raster reach it.
function preflight(text, image) {
  if (!text.startsWith("<0f>")) fail("frame");
  const record = /(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>/y;
  let position = 4;
  const objects = [];
  const ids = new Set();
  let pixels = 0;
  const fields = (body, allowed) => {
    const entries = body.split(";").map((field) => {
      const index = field.indexOf("="); return index < 0 ? [field] : [field.slice(0, index), field.slice(index + 1)];
    });
    if (entries.length !== allowed.length || entries.some(([key, value]) => !allowed.includes(key) || !value) || new Set(entries.map(([key]) => key)).size !== allowed.length) fail("fields");
    return Object.fromEntries(entries);
  };
  const integer = (value) => {
    if (!/^\d{1,10}$/.test(value) || !Number.isSafeInteger(Number(value))) fail("fields");
    return Number(value);
  };
  const confidence = (value) => {
    if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 1) fail("confidence");
    return Number(value);
  };
  while (position < text.length) {
    if (objects.length >= MAX_OBJECTS) fail("object_limit");
    record.lastIndex = position;
    const match = record.exec(text);
    if (!match) fail("grammar");
    const id = integer(match[1]);
    if (ids.has(id)) fail("duplicate_id");
    ids.add(id);
    const box = fields(match[2], ["x1", "y1", "x2", "y2", "w", "h", "c"]);
    const mask = fields(match[3], ["x", "y", "c", "data"]);
    const [x1, y1, x2, y2, w, h] = ["x1", "y1", "x2", "y2", "w", "h"].map((key) => integer(box[key]));
    if (w !== image.width || h !== image.height) fail("source_size");
    if (x2 < x1 || y2 < y1 || x2 >= w || y2 >= h) fail("bounds");
    if (confidence(box.c) !== confidence(mask.c)) fail("confidence");
    if (mask.x !== "0" || mask.y !== "0") fail("bounds");
    const data = /^(\d+),(\d+),([!~])(.+)$/.exec(mask.data);
    if (!data) fail("mask_encoding");
    const height = integer(data[1]); const width = integer(data[2]);
    if (!width || !height || width !== x2 - x1 + 1 || height !== y2 - y1 + 1) fail("mask_size");
    if (data[3] !== "!") fail("mask_encoding");
    pixels += width * height;
    if (pixels > MAX_MASK_PIXELS) fail("pixel_limit");
    objects.push({ id, box: { x1, y1, x2, y2 }, confidence: Number(box.c) });
    position = record.lastIndex;
    if (position < text.length) {
      if (text[position++] !== "," || position === text.length) fail("grammar");
    }
  }
  if (!objects.length) fail("grammar");
  return objects;
}

export function validateSamResponse(value, image) {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) {
    const error = new SamError("invalid_response", "schema");
    error.diagnostics = schemaDiagnostics(parsed.error); throw error;
  }
  if (parsed.data.status !== "completed") throw new SamError("incomplete_response");
  const lanes = parsed.data.output.flatMap((item) => item.content);
  if (lanes.length > 1) throw new SamError("invalid_response", "multiple_text_lanes");
  const text = lanes[0]?.text.trim() ?? "";
  if (!text) return [];
  const expected = preflight(text, image);
  const parser = formats.segmentation.image().createParser();
  let result;
  try { parser.push(text, { emit: false }); result = parser.finish({ status: "completed" }).result; }
  catch { fail("decode_failed"); }
  if (result.diagnostics.length) {
    const error = new SamError("invalid_segmentation", "parser_diagnostic");
    const allowed = new Set(["invalid_frame", "unexpected_frame", "malformed_record", "invalid_box", "invalid_mask_size", "invalid_mask_payload", "ignored_field", "ignored_confidence", "ignored_token"]);
    error.parserCodes = result.diagnostics.slice(0, 8).map(({ code }) => allowed.has(code) ? code : "unknown_diagnostic");
    throw error;
  }
  const masks = recordsOfKind(result.records, "mask");
  if (masks.length !== expected.length || result.records.length !== expected.length * 2) fail("grammar");
  return expected.map((object, index) => {
    const mask = masks[index];
    if (Number(mask.objectId) !== object.id || mask.bounds.left !== object.box.x1 || mask.bounds.top !== object.box.y1 ||
        mask.bounds.right !== object.box.x2 + 1 || mask.bounds.bottom !== object.box.y2 + 1) fail("bounds");
    let raster;
    try { raster = decodeMaskToRaster(mask.mask); } catch { fail("decode_failed"); }
    const area = raster.reduce((sum, bit) => sum + bit, 0);
    if (!area) fail("empty_mask");
    return { ...object, width: mask.mask.width, height: mask.mask.height, area, raster };
  });
}

function pngChunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const chunk = Buffer.alloc(bytes.length + 12);
  chunk.writeUInt32BE(bytes.length); data.copy(chunk, 4); chunk.writeUInt32BE(crc32(data), chunk.length - 4);
  return chunk;
}
export function renderMaskPng(object, image) {
  const pixels = Buffer.alloc((image.width + 1) * image.height);
  for (let y = 0; y < object.height; y++) {
    for (let x = 0; x < object.width; x++) {
      pixels[(object.box.y1 + y) * (image.width + 1) + object.box.x1 + x + 1] = object.raster[y * object.width + x] ? 255 : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width); header.writeUInt32BE(image.height, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

async function reserveEvidence(root) {
  try {
    const absolute = path.resolve(root);
    let current = path.parse(absolute).root;
    for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    const runId = randomUUID(); const directory = path.join(absolute, runId);
    await mkdir(directory, { mode: 0o700 }); return { directory, runId };
  } catch { throw new SamError("evidence_error"); }
}
async function readResponse(response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); throw new SamError("response_too_large");
  }
  if (!response.body) throw new SamError("invalid_response");
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SamError("response_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new SamError("invalid_response"); }
}

export async function runSamProbe({ screenshotPath, apiKey, live = false, fetchImpl = globalThis.fetch,
  evidenceRoot = path.resolve("data/spikes/task-008"), now = new Date() }) {
  if (!live) throw new SamError("live_required");
  if (!z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/).safeParse(apiKey).success) throw new SamError("missing_key");
  let image;
  try { image = await readScreenshot(screenshotPath); } catch { throw new SamError("invalid_image"); }
  const evidence = await reserveEvidence(evidenceRoot);
  const summary = { model: MODEL, utc: now.toISOString(), mode: fetchImpl === globalThis.fetch ? "live" : "mock",
    prompt: "button", screenshot: { sha256: image.sha256, width: image.width, height: image.height },
    requestCount: 0, timeoutMs: TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
    stage: "request", executed: false, targetConfirmed: false };
  const controller = new AbortController(); const started = performance.now(); let timer; let objects = [];
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new SamError("timeout"));
    }, TIMEOUT_MS); });
    summary.requestCount = 1;
    const value = await Promise.race([(async () => {
      const response = await fetchImpl(ENDPOINT, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(buildSamRequest(image)) });
      if (controller.signal.aborted) { await response.body?.cancel(); throw new SamError("timeout"); }
      if (!response.ok) {
        summary.httpStatus = response.status; await response.body?.cancel(); throw new SamError("http_error");
      }
      summary.stage = "read_response"; return readResponse(response);
    })(), deadline]);
    summary.stage = "validate";
    summary.responseShape = responseShape(value);
    // Discard all provider text if it echoes a credential; never write it to evidence.
    const serialized = JSON.stringify(value);
    if ([apiKey, Buffer.from(apiKey).toString("base64"), encodeURIComponent(apiKey)].some((key) => serialized.includes(key))) {
      throw new SamError("invalid_response", "credential_in_output");
    }
    const usage = usageSchema.safeParse(value?.usage);
    if (usage.success) summary.usage = usage.data;
    objects = validateSamResponse(value, image);
    summary.objects = objects.map(({ id, box, confidence, width, height, area }, index) =>
      ({ id, box, confidence, width, height, area, maskFile: `mask-${index}.png` }));
    summary.outcome = objects.length ? "validated_masks" : "no_matches";
    summary.stage = "complete";
  } catch (error) {
    summary.outcome = error instanceof SamError ? error.code : controller.signal.aborted || ["AbortError", "TimeoutError"].includes(error?.name) ? "timeout" : "network_error";
    if (error instanceof SamError && error.reason) summary.reason = error.reason;
    if (error instanceof SamError && error.diagnostics) summary.schemaIssues = error.diagnostics;
    if (error instanceof SamError && error.parserCodes) summary.parserCodes = error.parserCodes;
  } finally { clearTimeout(timer); summary.latencyMs = Math.max(0, Math.round(performance.now() - started)); }
  try {
    for (let index = 0; index < objects.length; index++) await writeFile(path.join(evidence.directory, `mask-${index}.png`), renderMaskPng(objects[index], image), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(evidence.directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch { throw new SamError("evidence_error"); }
  return { summary, runId: evidence.runId };
}
