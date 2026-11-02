import { z } from "zod";

export const teachHash = z.string().regex(/^[a-f0-9]{64}$/);
export const teachState = z.enum(["recording", "paused", "finalizing", "complete", "aborted", "failed", "discarded"]);
export const teachLease = { generation: z.string().uuid(), connectionId: z.string().uuid(), leaseId: z.string().uuid() };
export const teachControl = z.object({ ...teachLease, action: z.enum(["start", "status", "pause", "resume", "stop", "discard"]),
  captureId: z.string().uuid().optional(), narration: z.boolean().optional() }).strict()
  .refine((value) => value.action === "start" ? !value.captureId : !!value.captureId, "invalid capture control")
  .refine((value) => value.action === "start" || value.narration === undefined);
export const narrationUpload = z.object({ ...teachLease, sequence: z.number().int().min(0).max(299),
  offsetMs: z.number().int().min(0).max(120000), mime: z.enum(["audio/webm", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/wav"]),
  base64: z.string().min(4).max(4 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export const teachArtifact = z.object({ hash: teachHash, mime: z.enum(["image/png", "video/webm", "audio/wav"]),
  bytes: z.number().int().min(1).max(5 * 1024 * 1024), kind: z.enum(["before", "after", "video", "audio"]) }).strict();
const point = z.number().int().min(0).max(1023);
const ordinate = z.number().int().min(0).max(767);
export const teachEvent = z.object({ operation: z.enum(["input.click", "input.type", "input.key", "input.scroll", "input.drag"]),
  source_tag: z.literal("web"), untrusted: z.literal(true), sequence: z.number().int().min(0).max(299),
  offsetMs: z.number().int().min(0).max(120000), beforeHash: teachHash, afterHash: teachHash,
  width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768),
  target: z.object({ kind: z.enum(["point", "focused-control-redacted"]) }).strict(),
  x: point.optional(), y: ordinate.optional(), toX: point.optional(), toY: ordinate.optional(),
  button: z.enum(["left", "right", "double"]).optional(), direction: z.enum(["up", "down", "left", "right"]).optional(),
  count: z.number().int().min(1).max(20).optional(), key: z.string().regex(/^(?:(?:Control|Alt|Shift|Meta)\+)*(?:Enter|Tab|Escape|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$/).optional(),
  redacted: z.literal(true).optional(), length: z.number().int().min(0).max(4096).optional(),
  coordinateSpace: z.literal("screen").optional(),
  viewportOrigin: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().nullable().optional(),
}).strict().refine((event) => event.operation !== "input.type" || event.redacted === true)
  .refine((event) => event.operation === "input.key" ? event.redacted === true ? event.key === undefined : !!event.key && !/^[a-z0-9]$/i.test(event.key) : event.key === undefined);
export const teachAudio = z.object({ hash: teachHash, sequence: z.number().int().min(0).max(299),
  offsetMs: z.number().int().min(0).max(120000), durationMs: z.number().int().min(1).max(64000) }).strict();
export const teachManifest = z.object({ version: z.literal(1), captureId: z.string().uuid(), capturedAt: z.string().datetime(),
  timezone: z.string().max(100).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  durationMs: z.number().int().min(1).max(120000), videoHash: teachHash, events: z.array(teachEvent).max(300), audio: z.array(teachAudio).max(300),
  source_tag: z.literal("web"), untrusted: z.literal(true),
}).strict();
export const teachResult = z.object({ captureId: z.string().uuid(), state: teachState, reason: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  activeMs: z.number().int().min(0).max(120000), eventCount: z.number().int().min(0).max(300), narration: z.boolean(),
  manifest: teachManifest.optional(), artifacts: z.array(teachArtifact).max(1000).optional(),
  base64: z.string().max(7 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(), segment: teachAudio.optional(),
}).strict();
export const teachCaptureSummary = z.object({ captureId: z.string().uuid(), state: z.literal("complete"),
  activeMs: z.number().int().min(0).max(120000), eventCount: z.number().int().min(0).max(300), narration: z.boolean(),
  narrationStatus: z.enum(["off", "pending", "working", "complete", "error", "uncertain"]), createdAt: z.string().datetime() }).strict();
export const teachCaptureList = z.array(teachCaptureSummary).max(20);
export const narrationSegment = teachAudio.extend({ state: z.enum(["pending", "in_flight", "done", "uncertain"]),
  source_tag: z.literal("tool"), untrusted: z.literal(true), claimedAt: z.string().datetime().optional(),
  turns: z.array(z.object({ startMs: z.number().min(0).max(120000), endMs: z.number().min(0).max(120000), text: z.string().max(20000) }).strict()).max(1000).optional() }).strict();
export type NarrationSegment = z.infer<typeof narrationSegment>;
export type TeachResult = z.infer<typeof teachResult>;
export type TeachManifest = z.infer<typeof teachManifest>;
