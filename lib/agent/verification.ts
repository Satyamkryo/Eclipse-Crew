import "server-only";
import type { DesktopPort, Screenshot } from "./desktop-port";
import type { ProviderUsage } from "../providers/types";

export type Verdict = "pass" | "fail" | "unknown";
export type SamState = "off" | "on" | "unavailable";
export interface Evidence { method: "page_structure" | "sam" | "computer_use" | "model"; status: Verdict; code: string }
// `samBox` is set only when SAM found exactly one confident mask for the expected object: its box in the "after" screenshot
// (TASK-031 draws it as the highlight). It is display data, never a verdict.
export interface SamBox { x1: number; y1: number; x2: number; y2: number; width: number; height: number }
export interface Verification { status: Verdict; sam: SamState; evidence: Evidence[]; samBox?: SamBox }
export interface Expectation { kind: "control_present" | "control_absent" | "url_path" | "object_visible"; value: string }
export function parseExpectation(text: string): Expectation | null {
  const match = /^(control_present|control_absent|url_path|object_visible): (.{1,200})$/.exec(text);
  if (!match || /[\u0000-\u001f\u007f-\u009f]/.test(match[2]) || !match[2].trim()) return null;
  if (match[1] === "url_path" && (!match[2].startsWith("/") || match[2].startsWith("//") || /[?#\\]/.test(match[2]))) return null;
  return { kind: match[1] as Expectation["kind"], value: match[2] };
}
export interface VisualObservation { status: Verdict; name: string; role: string }
export interface VisualVerifier {
  observe(shot: Screenshot, action: string): Promise<VisualObservation>;
  verify(before: Screenshot, after: Screenshot, expect: string): Promise<Verdict>;
  // Visual grounding: does this pixel sit on the one visible control the target describes? Optional for injected fakes.
  confirmPoint?(shot: Screenshot, target: string, point: { x: number; y: number }): Promise<Verdict>;
}
export interface SamVerifier { masks(shot: Screenshot, concept: string): Promise<import("./sam-parser.mjs").SamMask[]> }
export interface VerificationServices { visual: VisualVerifier; samState: SamState; sam?: SamVerifier }
export const emptyUsage = (): ProviderUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
export function addUsage(total: ProviderUsage, delta: ProviderUsage) {
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"] as const) total[key] += delta[key];
}
export function checkCancelled(signal?: AbortSignal) { if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" }); }
// Also bounds injected test implementations and transports that ignore AbortSignal.
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkCancelled(signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(Object.assign(new Error("aborted"), { code: "aborted" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error("verification_timeout")); }, 30000);
  });
  try { return await Promise.race([work(controller.signal), deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

export async function verifyStep(input: {
  desktop: DesktopPort; services: VerificationServices; before: Screenshot; expect: string;
  signal?: AbortSignal; sleep: (ms: number) => Promise<void>;
  // Called with the "after" screenshot when this check takes one, so a receipt can hash it (TASK-029).
  onAfter?: (shot: Screenshot) => void;
}): Promise<Verification> {
  const { desktop, services, before, expect, signal, sleep } = input;
  const evidence: Evidence[] = [];
  let samBox: SamBox | undefined;
  const finish = (status: Verdict): Verification => ({ status, evidence, sam: services.samState, ...(samBox ? { samBox } : {}) });
  checkCancelled(signal);
  const parsed = parseExpectation(expect);
  if (parsed && parsed.kind !== "object_visible" && desktop.verify) {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkCancelled(signal);
      const result = await desktop.verify({ kind: parsed.kind, value: parsed.value });
      if (result.status !== "fail" || attempt === 2) {
        evidence.push({ method: "page_structure", status: result.status, code: result.code });
        if (result.status !== "unknown") return finish(result.status);
        break;
      }
      await sleep(500);
    }
  }
  checkCancelled(signal);
  // A screenshot taken while the page is still loading shows placeholders, so the check can't succeed yet. Wait (bounded)
  // until two screenshots in a row match before judging. Pages with video or animation never match; they are judged
  // when the wait runs out.
  let after = await settledScreenshot(desktop, sleep, signal);
  // The browser can close between the action and this check. No picture means no independent verification.
  if (!after) {
    evidence.push({ method: "model", status: "unknown", code: "visual_unavailable" });
    return finish("unknown");
  }
  let status: Verdict = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    input.onAfter?.(after);
    if (parsed?.kind === "object_visible" && services.samState === "on" && services.sam) {
      try {
        const masks = await services.sam.masks(after, parsed.value);
        const matches = masks.filter((mask) => mask.confidence !== null && mask.confidence >= 0.90);
        const samStatus = matches.length === 1 && masks.length === 1 ? "pass" : "unknown";
        evidence.push({ method: "sam", status: samStatus, code: samStatus === "pass" ? "unique_mask" : "ambiguous_or_missing_mask" });
        if (samStatus === "pass") { const { x1, y1, x2, y2 } = matches[0].box; samBox = { x1, y1, x2, y2, width: after.width, height: after.height }; return finish("pass"); }
      } catch { checkCancelled(signal); evidence.push({ method: "sam", status: "unknown", code: "sam_unavailable" }); }
    }
    checkCancelled(signal);
    status = await services.visual.verify(before, after, expect);
    evidence.push({ method: "model", status, code: "visual_postcondition" });
    checkCancelled(signal);
    // Only "unknown" is worth a second look, and only when the screen has moved on since it was judged (a slow page
    // finished loading). A "fail" is never re-asked, and a still screen is never judged twice.
    if (status !== "unknown" || attempt > 0) break;
    await sleep(RECHECK_DELAY_MS);
    checkCancelled(signal);
    const later = await desktop.screenshot();
    if (!later || later.base64 === after.base64) break;
    after = later;
  }
  return finish(status);
}

// Bounded wait for the screen to stop changing after an action (TASK-084 navigation, slow single-page apps).
export const SETTLE_POLL_MS = 750;
export const SETTLE_MAX_MS = 4_000;
export const RECHECK_DELAY_MS = 3_000;

async function settledScreenshot(desktop: DesktopPort, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<Screenshot | null> {
  let previous = await desktop.screenshot();
  for (let waited = 0; previous && waited < SETTLE_MAX_MS; waited += SETTLE_POLL_MS) {
    await sleep(SETTLE_POLL_MS);
    checkCancelled(signal);
    const next = await desktop.screenshot();
    if (!next) return previous;
    if (next.base64 === previous.base64) return next;
    previous = next;
  }
  return previous;
}
