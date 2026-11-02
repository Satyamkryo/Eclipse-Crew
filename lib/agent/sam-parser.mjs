import "server-only";
import { decodeMaskToRaster, formats, recordsOfKind } from "@meta-sam/parser";
import { z } from "zod";
const MODEL = "sam-3.1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MASK_PIXELS = 16000000;
const MAX_OBJECTS = 64;
class SamError extends Error { constructor(code, reason) { super(code); this.code = code; this.reason = reason; } }
const fail = (reason) => { throw new SamError("invalid_segmentation", reason); };
const envelope = z.object({ model: z.literal(MODEL), status: z.string(), output: z.array(z.object({
  type: z.literal("message"), role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("output_text"), text: z.string().max(MAX_RESPONSE_BYTES) })).max(16),
})).max(16) });
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
    if (entries.some(([key, value]) => !allowed.includes(key) || !value) || allowed.filter(k => k !== "c").some(k => !entries.some(([key]) => key === k)) || new Set(entries.map(([key]) => key)).size !== entries.length) fail("fields");
    return Object.fromEntries(entries);
  };
  const integer = (value) => {
    if (!/^\d{1,10}$/.test(value) || !Number.isSafeInteger(Number(value))) fail("fields");
    return Number(value);
  };
  const confidence = (value) => {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) fail("confidence");
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
    const boxConfidence = box.c === undefined ? null : confidence(box.c);
    const maskConfidence = mask.c === undefined ? null : confidence(mask.c);
    if (mask.x !== "0" || mask.y !== "0") fail("bounds");
    const data = /^(\d+),(\d+),([!~])(.+)$/.exec(mask.data);
    if (!data) fail("mask_encoding");
    const height = integer(data[1]); const width = integer(data[2]);
    if (!width || !height || width !== x2 - x1 + 1 || height !== y2 - y1 + 1) fail("mask_size");
    if (data[3] !== "!") fail("mask_encoding");
    pixels += width * height;
    if (pixels > MAX_MASK_PIXELS) fail("pixel_limit");
    objects.push({ id, box: { x1, y1, x2, y2 }, confidence: boxConfidence === null || maskConfidence === null ? null : Math.min(boxConfidence, maskConfidence) });
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
  if (!parsed.success) throw new SamError("invalid_response", "schema");
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

