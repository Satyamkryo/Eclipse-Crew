// TASK-054. Pure pattern scanner for agent-originated memory. It is one control, not the real one: the owner's diff
// approval is what keeps persistent prompt injection out. A rejection creates no row, no card and no receipt text.

export const SCAN_CODES = [
  "hidden_text", "markup", "instruction_like", "secret_like", "external_address",
] as const;
export type ScanCode = (typeof SCAN_CODES)[number];
export type ScanVerdict = "allowed" | "flagged" | "rejected";

export interface ScanResult { verdict: ScanVerdict; codes: ScanCode[] }

const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]|[\u{E0000}-\u{E007F}]/u;
const MARKUP = [
  /<\/?[a-z][^>]*>/i,
  /(?:javascript|data)\s*:/i,
  /!\[[^\]]*\]\([^)]*\)/,
];
const INSTRUCTION = [
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier)\b[^.\n]{0,20}\b(?:instruction|prompt|message|rule)s?\b/i,
  /\bfrom now on\b/i,
  /\byou must (?:now|always)\b/i,
  /\bnew instructions?\b/i,
  /\bsystem prompt\b/i,
  /\bdeveloper message\b/i,
  /\bact as\b/i,
  /\bdo not (?:tell|inform) the (?:owner|user)\b/i,
  /\bwithout (?:asking|approval)\b/i,
  /^\s*(?:system|assistant|developer)\s*:/im,
  /source_tag=|content_json=/,
  /\balways\b[^.\n]{0,40}\b(?:send|email|forward|upload|post)\b[^.\n]{0,60}\b(?:https?:\/\/|@)/i,
];
const SECRET = [
  /\becx-[a-z0-9]{8,}\b/i,
  /\bsk-[a-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  /\b(?=[0-9a-f]*\d)[0-9a-f]{40,}\b/i,
  /\b(?=[A-Za-z0-9+/]{40,}={0,2}\b)(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{40,}={0,2}\b/,
  /\bpassword\s*(?:is|:)\s*\S+/i,
  /\bpass(?:word)?\s*:\s*\S+/i,
];
const ADDRESS = [
  /\bhttps?:\/\/[^\s)]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|ai|co|app|test|example|local)\b/i,
];

export function scanMemoryText(input: { title: string; text: string; reason?: string | null }): ScanResult {
  const raw = [input.title, input.text, input.reason ?? ""].join("\n");
  const value = raw.normalize("NFKC").toLowerCase();
  const codes = new Set<ScanCode>();
  if (HIDDEN.test(raw.normalize("NFKC"))) codes.add("hidden_text");
  if (MARKUP.some((pattern) => pattern.test(raw))) codes.add("markup");
  if (INSTRUCTION.some((pattern) => pattern.test(value))) codes.add("instruction_like");
  if (SECRET.some((pattern) => pattern.test(raw))) codes.add("secret_like");
  const rejected = ["hidden_text", "markup", "instruction_like", "secret_like"].some((code) => codes.has(code as ScanCode));
  if (ADDRESS.some((pattern) => pattern.test(raw))) codes.add("external_address");
  return {
    verdict: rejected ? "rejected" : codes.size > 0 ? "flagged" : "allowed",
    codes: [...codes],
  };
}
