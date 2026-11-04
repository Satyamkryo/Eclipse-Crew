import "server-only";
import type { CheckpointSink } from "../checkpoints/store";
import type { StepSummary } from "../agent/context";
import type { DeliveredFile, DesktopPort, PageControl, PageSnapshot, Screenshot } from "../agent/desktop-port";
import { executeIntent, validPoint } from "../agent/executor";
import { centreOf } from "../agent/grounding";
import type { Intent } from "../agent/intent";
import { MAX_WALL_CLOCK_MS, claimAgent, type RunCard } from "../agent/step-loop";
import { classifyAction, type ActionClass } from "../agent/risk";
import { hostFromUrl } from "../agent/scope";
import { parseExpectation, type Evidence, type Verification } from "../agent/verification";
import { cleanText } from "../receipts/chain.mjs";
import type { EvidenceSink } from "../receipts/evidence";
import { actionFor, confidenceFor, methodsFor, screenshotHash, type ReceiptResult, type ReceiptSink } from "../receipts/fields";
import type { ReplayStep } from "./script";

// TASK-041. Runs a saved replay script with no model. There is no provider, verifier or SAM service in these dependencies on
// purpose: the only checks are the page's own structure, so a replay can't spend a token. Anything that doesn't match stops
// the run for the owner; calling the model on a mismatch is TASK-044.

export type ReplayOutcome = "finished" | "needs_owner" | "paused_by_owner" | "time_limit" | "aborted" | "desktop_error" | "receipt_error" | "busy";
export type MismatchCode =
  | "action_not_allowed" | "page_unreadable" | "target_missing" | "ambiguous_target" | "target_changed" | "unsupported_focus"
  | "input_missing" | "postcondition_failed" | "postcondition_unknown" | "file_failed" | "approval_required";

const REASON_TEXT: Record<MismatchCode, string> = {
  action_not_allowed: "this agent is no longer allowed to do that action",
  page_unreadable: "I could not read the page",
  target_missing: "the control this step needs is not on the page",
  ambiguous_target: "more than one control matches this step",
  target_changed: "the control moved or changed before I could use it",
  unsupported_focus: "the right text field is not focused",
  input_missing: "a value this step needs was not provided",
  postcondition_failed: "the page did not show the expected result",
  postcondition_unknown: "I could not check the expected result",
  file_failed: "the file could not be sent",
  approval_required: "this step needs the owner's approval, and no saved approval with capacity applies",
};
const FIXED_TEXT: Record<Exclude<ReplayOutcome, "finished" | "needs_owner" | "busy">, string> = {
  paused_by_owner: "I stopped because you took over the desktop.",
  time_limit: "I stopped because this run reached its time limit.",
  aborted: "I stopped because the run was cancelled.",
  desktop_error: "I stopped because the desktop did not accept a command.",
  receipt_error: "I stopped because I could not record proof of my last step.",
};
const TEXTBOX_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];

export interface ReplayDeps {
  agent: { id: string; name: string; actions: readonly string[] };
  script: { name: string; steps: readonly ReplayStep[] };
  // Text for each `type` step by step number. Used once, never stored or logged.
  inputs: ReadonlyMap<number, string>;
  desktop: DesktopPort;
  receipts?: ReceiptSink;
  evidence?: EvidenceSink;
  checkpoints?: CheckpointSink;
  postCard: (card: RunCard) => Promise<void>;
  // TASK-050. Replay never waits for the owner: a risky step proceeds only with a live grant that still has capacity.
  approvals?: (input: { actionClass: ActionClass; site: string | null; runId: string | null }) => Promise<"allowed" | "approval_required">;
  onFileDelivered?: (file: DeliveredFile) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  maxWallClockMs?: number;
}
export interface ReplayResult {
  outcome: ReplayOutcome;
  // Steps that were carried out and passed their check, by step number.
  done: number[];
  stoppedAt: { step: number; code: MismatchCode } | null;
  cardPosted: boolean;
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sameControl = (a: PageControl, b: PageControl) =>
  a.name === b.name && a.role === b.role && a.tag === b.tag && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const nameOf = (control: PageControl) => cleanText(control.name, 200);
const ZERO_USAGE = { input: 0, output: 0, cached: 0, reasoning: 0 };

function intentOf(step: ReplayStep, inputs: ReadonlyMap<number, string>): Intent {
  switch (step.action) {
    case "click": return { action: "click", target: step.name, expect: step.expect };
    case "type": return { action: "type", text: inputs.get(step.idx) ?? "", expect: step.expect };
    case "key": return { action: "key", keys: step.keys, expect: step.expect };
    case "scroll": return { action: "scroll", direction: step.direction, expect: step.expect };
    case "wait": return { action: "wait", expect: step.expect };
    case "deliver_file": return { action: "deliver_file", from: step.from, name: step.file, expect: "-" };
  }
}

// Typed text is never kept: only its length (the same rule as the step loop's checkpoints).
function summaryOf(step: ReplayStep, result: StepSummary["result"], code?: string): StepSummary {
  return {
    step: step.idx, action: step.action, result, ...(code ? { code } : {}),
    ...(step.action === "click" ? { target: step.name } : {}),
    ...(step.action === "type" ? { chars: step.chars } : {}),
    ...(step.action === "deliver_file" ? { file: step.file } : {}),
    ...("expect" in step ? { expect: step.expect } : {}),
  };
}

export async function runReplay(deps: ReplayDeps): Promise<ReplayResult> {
  const done: number[] = [];
  const release = claimAgent(deps.agent.id);
  if (!release) return { outcome: "busy", done, stoppedAt: null, cardPosted: false };

  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const wallClock = deps.maxWallClockMs ?? MAX_WALL_CLOCK_MS;
  const deadlineAt = now().getTime() + wallClock;
  const controller = new AbortController();
  let deadlineExpired = false;
  const timer = setTimeout(() => { deadlineExpired = true; controller.abort("deadline"); }, wallClock);
  timer.unref?.();
  const onOwnerAbort = () => controller.abort("owner");
  if (deps.signal?.aborted) onOwnerAbort(); else deps.signal?.addEventListener("abort", onOwnerAbort, { once: true });
  const limitError = () => Object.assign(new Error("stopped"), { code: deadlineExpired ? "time_limit" : "aborted" });
  const withinDeadline = async <T>(work: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw limitError();
    let abortWork = () => {};
    const stopped = new Promise<never>((_, reject) => { abortWork = () => reject(limitError()); controller.signal.addEventListener("abort", abortWork, { once: true }); });
    try { return await Promise.race([work, stopped]); } finally { controller.signal.removeEventListener("abort", abortWork); }
  };

  let outcome: ReplayOutcome = "finished";
  let stoppedAt: ReplayResult["stoppedAt"] = null;
  const stop = (next: ReplayOutcome) => { outcome = next; };
  const mismatch = (step: ReplayStep, code: MismatchCode) => { stoppedAt = { step: step.idx, code }; stop("needs_owner"); };
  const stopIfStopped = () => {
    if (deps.signal?.aborted) { stop("aborted"); return true; }
    if (deadlineExpired || now().getTime() >= deadlineAt) { stop("time_limit"); return true; }
    return false;
  };
  const stopForError = (error: unknown) => {
    const code = errorCode(error);
    stop(code === "takeover_active" ? "paused_by_owner" : code === "time_limit" ? "time_limit" : code === "aborted" ? "aborted" : "desktop_error");
  };

  const allowed = new Set(deps.agent.actions.map((action) => action.toLowerCase()));
  const task = `Replay: ${deps.script.name}`;
  const history: StepSummary[] = [];
  const delivered: string[] = [];
  const receipts = deps.receipts;
  let receiptIdx = 0;
  let started = true;

  const captureCheckpoint = async (idx: number, turn: number) => {
    await deps.checkpoints?.capture(idx, {
      task: task.slice(0, 2000), turn, receiptIdx: idx, history: [...history], documents: [], delivered: [...delivered],
      counters: { invalid: 0, repeats: 0, misses: 0, hardTurns: 0, hardDisabled: false }, previous: null, usage: ZERO_USAGE,
    }).catch(() => undefined);
  };
  // One receipt, then evidence, then the checkpoint, in the same order as the step loop. False means the proof was not stored.
  const emit = async (step: ReplayStep, d: {
    result: ReceiptResult; executed: boolean; code?: string | null; target?: { role: string; name: string } | null;
    gate?: Evidence[]; verification?: Verification; before?: Screenshot | null; after?: Screenshot | null;
  }): Promise<boolean> => {
    if (!receipts) return true;
    const action = actionFor(intentOf(step, deps.inputs));
    if (!action) return true;
    const methods = methodsFor(d.gate, d.verification);
    try {
      await receipts.step({
        idx: receiptIdx + 1, model: "none", model_label: "No model", route: "replay", action,
        target: d.target ? { role: cleanText(d.target.role, 64), name: cleanText(d.target.name, 200) } : null,
        grounding_method: d.target ? "page_structure" : null, methods, sam: "off", confidence: confidenceFor(action, d.result, methods),
        before_hash: d.before ? screenshotHash(d.before.base64) : null, after_hash: d.after ? screenshotHash(d.after.base64) : null,
        postcondition: "expect" in step ? cleanText(step.expect, 300) : "", result: d.result, code: d.code ? cleanText(d.code, 64) : null,
        executed: d.executed, usage: { ...ZERO_USAGE }, cost_micro_usd: 0,
      });
    } catch { return false; }
    receiptIdx += 1;
    await deps.evidence?.record({ idx: receiptIdx, before: d.before ?? null, after: d.after ?? null, samBox: null }).catch(() => undefined);
    await captureCheckpoint(receiptIdx, step.idx);
    return true;
  };

  try {
    // A missing value is a caller bug (the route checks the inputs); never type an empty string for the owner.
    const lacking = deps.script.steps.find((step) => step.action === "type" && !deps.inputs.get(step.idx));
    if (lacking) { mismatch(lacking, "input_missing"); started = false; }
    if (started && receipts) {
      try { await withinDeadline(receipts.begin()); }
      catch (error) { started = false; stop(errorCode(error) === "time_limit" ? "time_limit" : errorCode(error) === "aborted" ? "aborted" : "receipt_error"); }
    }
    if (started && receipts) await captureCheckpoint(0, 0);

    for (const step of started ? deps.script.steps : []) {
      if (stopIfStopped()) break;
      const need = step.action;
      if (!allowed.has(need) || (need === "deliver_file" && !deps.desktop.deliverFile)) { mismatch(step, "action_not_allowed"); break; }

      // File step: no screen involved, so no gate; a failure is reported with a fixed code.
      if (step.action === "deliver_file") {
        try {
          const file = await withinDeadline(deps.desktop.deliverFile!(step.from, step.file));
          delivered.push(file.name);
          await deps.onFileDelivered?.(file).catch(() => undefined);
        } catch (error) {
          if (stopIfStopped()) break;
          const code = errorCode(error);
          history.push(summaryOf(step, "failed", typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "tool_failed"));
          if (!(await emit(step, { result: "failed", executed: false, code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "tool_failed" }))) { stop("receipt_error"); break; }
          mismatch(step, "file_failed");
          break;
        }
        history.push(summaryOf(step, "executed"));
        if (!(await emit(step, { result: "executed", executed: true }))) { stop("receipt_error"); break; }
        done.push(step.idx);
        continue;
      }

      let before: Screenshot | null;
      try { before = await withinDeadline(deps.desktop.screenshot()); }
      catch (error) { if (!stopIfStopped()) stopForError(error); break; }
      if (!before) { stop("desktop_error"); break; }
      // Like the step loop's gate, only click, type and key are checked against the page; scroll and wait have no target.
      const gated = step.action === "click" || step.action === "type" || step.action === "key";
      let snapshot: PageSnapshot | null = null;
      if (gated) {
        try { snapshot = await withinDeadline(deps.desktop.snapshot()); }
        catch (error) {
          if (stopIfStopped()) break;
          if (errorCode(error) === "takeover_active") { stop("paused_by_owner"); break; }
        }
      }

      // Gate: the page's own structure, one method. Click needs exactly one control with this role and exact name; type and
      // key need exactly one focused control (a text field for type). The match is read again before any input.
      const blocked = async (code: MismatchCode, gate: Evidence[] = []) => {
        history.push(summaryOf(step, "failed", code));
        if (!(await emit(step, { result: "blocked", executed: false, code, gate: [...gate, { method: "page_structure", status: "unknown", code }], before }))) { stop("receipt_error"); return; }
        mismatch(step, code);
      };
      let target: PageControl | null = null;
      let point: { x: number; y: number; method: string; role: string; name: string } | null = null;
      const gate: Evidence[] = [];
      if (gated) {
        if (!snapshot) { await blocked("page_unreadable"); break; }
        const candidates = step.action === "click"
          ? snapshot.controls.filter((control) => control.role === step.role && nameOf(control) === step.name)
          : snapshot.controls.filter((control) => control.focused === true);
        const none = candidates.length === 0;
        if (candidates.length !== 1 || !candidates[0].name || snapshot.controls.filter((c) => c.name === candidates[0].name && c.role === candidates[0].role).length !== 1) {
          // No match: a click names a control that is not there; type and key need a focused field and there is none.
          await blocked(none ? (step.action === "click" ? "target_missing" : "unsupported_focus") : "ambiguous_target");
          break;
        }
        target = candidates[0];
        if (step.action === "type" && !TEXTBOX_ROLES.includes(target.role)) { await blocked("unsupported_focus"); break; }
        point = step.action === "click" ? { ...centreOf(target), method: "page_structure", role: target.role, name: target.name } : null;
        if (step.action === "click" && !validPoint(point, before)) { await blocked("target_missing"); break; }
        gate.push({ method: "page_structure", status: "pass", code: "unique_target" });
        let fresh: PageSnapshot | null;
        try { fresh = await withinDeadline(deps.desktop.snapshot()); }
        catch (error) { if (!stopIfStopped()) stopForError(error); break; }
        if (!fresh) { await blocked("page_unreadable"); break; }
        const chosen = target;
        const again = fresh.controls.filter((control) => sameControl(chosen, control) && (step.action === "click" || control.focused === true));
        if (fresh.href !== snapshot.href || again.length !== 1 || fresh.controls.filter((c) => c.name === chosen.name && c.role === chosen.role).length !== 1) {
          await blocked("target_changed", gate);
          break;
        }
      }
      // TASK-050. The classification is code-made, exactly as in a chat run. Replay cannot ask, so it needs a grant.
      const actionClass = step.action === "click" && target
        ? classifyAction({ intentKind: "click", controlName: target.name, expect: step.expect })
        : "none";
      if (actionClass !== "none") {
        const verdict = deps.approvals
          ? await deps.approvals({ actionClass, site: hostFromUrl(snapshot?.href), runId: receipts?.runId ?? null })
          : "approval_required";
        if (verdict !== "allowed") { await blocked("approval_required", gate); break; }
      }

      const grounded = step.action === "click" && target ? { role: target.role, name: target.name } : null;
      let after: Screenshot | null = null;
      let verification: Verification | undefined;
      let executed = false;
      let emitted = false;
      try {
        if (stopIfStopped()) break;
        await withinDeadline(executeIntent(intentOf(step, deps.inputs), deps.desktop, point, sleep));
        executed = true;
        verification = await withinDeadline(checkPostcondition(deps.desktop, step.expect, sleep));
        try { after = await deps.desktop.screenshot(); } catch { after = null; }
        const result = verification.status;
        history.push(summaryOf(step, result === "pass" ? "executed" : "failed", result === "pass" ? undefined : result === "fail" ? "postcondition_failed" : "postcondition_unknown"));
        emitted = true;
        if (!(await emit(step, { result, executed: true, target: grounded, gate, verification, before, after }))) { stop("receipt_error"); break; }
        if (stopIfStopped()) break;
        if (result !== "pass") { mismatch(step, result === "fail" ? "postcondition_failed" : "postcondition_unknown"); break; }
        done.push(step.idx);
      } catch (error) {
        if (!emitted) {
          const code = errorCode(error);
          history.push(summaryOf(step, "failed"));
          if (!(await emit(step, { result: executed ? "unknown" : "failed", executed, target: grounded, gate, before, after,
            code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "desktop_error" }))) { stop("receipt_error"); break; }
        }
        if (!stopIfStopped()) stopForError(error);
        break;
      }
    }

    if (receipts && started) { try { await receipts.seal(outcome, { ...ZERO_USAGE }); } catch { /* an unsealed run fails verification, as for chat runs */ } }
    const stopped = stoppedAt as ReplayResult["stoppedAt"];
    const card: RunCard = { type: "message", text: outcome === "finished"
      ? `Replay finished: ${deps.script.steps.length} ${deps.script.steps.length === 1 ? "step" : "steps"} checked, no model used.`
      : stopped ? `Replay stopped at step ${stopped.step}: ${REASON_TEXT[stopped.code]}. Take over or ask me to redo it.`
      : FIXED_TEXT[outcome as keyof typeof FIXED_TEXT] };
    let cardPosted = false;
    try { await deps.postCard(card); cardPosted = true; } catch { /* the caller sees cardPosted: false */ }
    return { outcome, done, stoppedAt: stopped, cardPosted };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onOwnerAbort);
    release();
  }
}

// Structural postconditions only. A missing verifier, an unreadable page or an unrecognised check is "unknown", which is a
// mismatch: replay never falls back to a screenshot judgement by a model.
async function checkPostcondition(desktop: DesktopPort, expect: string, sleep: (ms: number) => Promise<void>): Promise<Verification> {
  const parsed = parseExpectation(expect);
  const evidence: Evidence[] = [];
  const finish = (status: Verification["status"]): Verification => ({ status, evidence, sam: "off" });
  if (!parsed || parsed.kind === "object_visible" || !desktop.verify) {
    evidence.push({ method: "page_structure", status: "unknown", code: "no_structural_check" });
    return finish("unknown");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await desktop.verify({ kind: parsed.kind, value: parsed.value });
    if (result.status !== "fail" || attempt === 2) {
      evidence.push({ method: "page_structure", status: result.status, code: result.code });
      return finish(result.status);
    }
    await sleep(500);
  }
  return finish("unknown");
}
