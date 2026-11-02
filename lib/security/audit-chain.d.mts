import type { KeyObject } from "node:crypto";

export const AUDIT_FORMAT: "eclipse-crew-audit/1";
export const AUDIT_VERSION: 1;
export const AUDIT_REASONS: readonly string[];

export interface AuditEntryInput {
  seq: number;
  kind: string;
  agentId: string | null;
  runId: string | null;
  ref: string | null;
  code: string | null;
  host: string | null;
  ts: string;
  prevHash: string;
}

export interface AuditExportEntry {
  seq: number;
  entry: string;
  entry_hash: string;
  prev_hash: string;
  signature: string;
}

export interface AuditExport {
  format: "eclipse-crew-audit/1";
  owner_id: string;
  key_id: string;
  public_key: string;
  exported_at: string;
  entries: AuditExportEntry[];
}

export type AuditVerifyResult =
  | { ok: true; ownerId: string; keyId: string; entries: number; headSeq: number; headHash: string; pinned: boolean }
  | { ok: false; reason: string; seq?: number };

export function genesisHash(ownerId: string): string;
export function entryFields(input: AuditEntryInput): Record<string, unknown>;
export function buildAuditEntry(input: AuditEntryInput): { text: string; hash: string };
export function signAuditEntry(privateKey: KeyObject, entryHash: string): string;
export function buildAuditExport(input: {
  ownerId: string;
  keyId: string;
  publicKey: string;
  exportedAt: string;
  entries: { seq: number; entryText: string; entryHash: string; prevHash: string; signature: string }[];
}): AuditExport;
export function verifyAuditExport(
  exported: unknown,
  options?: { pinnedKeyId?: string; expectSeq?: number },
): AuditVerifyResult;
