import type { KeyObject } from "node:crypto";

export const RECEIPT_VERSION: 1;
export const EXPORT_FORMAT: "eclipse-crew-run/1";
export const REASONS: readonly string[];

export interface SealUsage { input: number; output: number; cached: number; reasoning: number }
export interface SealFields {
  runId: string; headerHash: string; stepCount: number; headHash: string; status: string; endedAt: string; usage: SealUsage;
}
export interface RunExport {
  format: "eclipse-crew-run/1";
  run_id: string;
  header: string;
  header_hash: string;
  key_id: string;
  public_key: string;
  steps: { idx: number; receipt: string; receipt_hash: string; prev_hash: string }[];
  seal: { status: string; ended_at: string; step_count: number; head_hash: string; usage: SealUsage; signature: string } | null;
}
export type VerifyResult =
  | { ok: true; runId: string; keyId: string; steps: number; pinned: boolean }
  | { ok: false; reason: string; step?: number };

export function isKeyId(value: unknown): value is string;
export function isUuid(value: unknown): value is string;
export function canonicalJson(value: unknown): string;
export function sha256Hex(data: string | Uint8Array): string;
export function cleanText(value: unknown, max: number): string;
export function keyIdOf(publicKeyRaw: Uint8Array): string;
export function deriveKeys(seedHex: string): { privateKey: KeyObject; publicKey: string; keyId: string };
export function buildHeader(input: { runId: string; agentId: string; agentName: string; task: string; startedAt: string; keyId: string }): { text: string; hash: string };
export function buildReceipt(fields: Record<string, unknown>, prevHash: string): { text: string; hash: string };
export function sealRun(privateKey: KeyObject, seal: SealFields): string;
export function buildRunExport(
  run: { runId: string; headerText: string; headerHash: string; keyId: string; publicKey: string;
    seal: { status: string; endedAt: string; stepCount: number; headHash: string; usage: SealUsage; signature: string } | null },
  steps: { idx: number; receiptText: string; receiptHash: string; prevHash: string }[],
): RunExport;
export function verifyRunExport(exported: unknown, options?: { pinnedKeyId?: string }): VerifyResult;
