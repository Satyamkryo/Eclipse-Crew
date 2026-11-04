import { z } from "zod";

export const MEMORY_DOCUMENTS = ["user", "memory", "private"] as const;
export type MemoryDocument = (typeof MEMORY_DOCUMENTS)[number];
export const MEMORY_SCOPES = ["global", "agent", "private"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

// Caps count title + body of active entries. SOUL keeps the existing 2,000-character persona cap.
export const MEMORY_CAPS: Record<MemoryDocument | "soul", number> = {
  user: 1_500, memory: 3_000, private: 2_200, soul: 2_000,
};
export const MAX_VISIBLE_TO = 10;

const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/;
export const plainTitle = z.string().trim().min(1).max(80).refine((value) => !forbidden.test(value), "contains unsupported characters");
export const plainBody = z.string().trim().min(1).max(600).refine((value) => !forbidden.test(value), "contains unsupported characters");
export const plainReason = z.string().trim().min(1).max(200).refine((value) => !forbidden.test(value), "contains unsupported characters");
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);
export const memoryDocumentSchema = z.enum(MEMORY_DOCUMENTS);
export const visibleToSchema = z.array(z.string().uuid()).max(MAX_VISIBLE_TO)
  .transform((values) => [...new Set(values)]);

export const ownerAddSchema = z.object({
  doc: memoryDocumentSchema,
  title: plainTitle,
  body: plainBody,
  pinned: z.boolean().optional(),
  visibleTo: visibleToSchema.optional(),
}).strict();

export const ownerEditSchema = z.object({
  title: plainTitle.optional(),
  body: plainBody.optional(),
  pinned: z.boolean().optional(),
  visibleTo: visibleToSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "nothing to change");

export const soulInputSchema = z.object({
  // Persona is optional, so an empty PERSONA.md is allowed.
  soulMd: z.string().trim().max(MEMORY_CAPS.soul).refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "contains unsupported control characters",
  ),
}).strict();

export const memoryHistoryQuerySchema = z.object({
  doc: z.string().min(1).max(120),
}).strict();

export function docKeyFor(doc: MemoryDocument, agentId: string): string {
  return doc === "user" ? "user" : `agent:${agentId}:${doc}`;
}

export function soulDocKey(agentId: string): string {
  return `agent:${agentId}:soul`;
}

export function capFor(doc: MemoryDocument): number {
  return MEMORY_CAPS[doc];
}

export function scopeFor(doc: MemoryDocument): MemoryScope {
  return doc === "user" ? "global" : doc === "memory" ? "agent" : "private";
}

export function entryChars(entry: { title: string; body: string }): number {
  return entry.title.length + entry.body.length;
}

// Remove control, zero-width and bidi characters before memory text reaches instructions or the UI.
export function cleanMemoryText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/ {2,}/g, " ").trim().toWellFormed().slice(0, max);
}

export interface MemoryEntryView {
  id: string;
  doc: MemoryDocument;
  agentId: string | null;
  scope: MemoryScope;
  visibleTo: string[];
  title: string;
  body: string;
  pinned: boolean;
  trusted: boolean;
  status: "active" | "archived";
  author: "owner" | "agent";
  sourceRunId: string | null;
  sourceLabel: string | null;
  // TASK-086. Set when a repeat restates the fact; tidy keeps confirmed entries ahead of stale ones.
  lastConfirmedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersionView {
  id: string;
  docKey: string;
  seq: number;
  entryId: string | null;
  agentId: string | null;
  op: string;
  before: MemorySnapshotShape | null;
  after: MemorySnapshotShape | null;
  author: "owner" | "agent";
  authorAgentId: string | null;
  reason: string | null;
  sourceRunId: string | null;
  createdAt: string;
}

export interface MemorySnapshotShape {
  title: string;
  body: string;
  pinned: boolean;
  status: string;
  scope: string;
  visibleTo: string[];
}
