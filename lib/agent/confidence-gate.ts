import "server-only";
import type { DesktopPort, PageControl, PageSnapshot, Screenshot } from "./desktop-port";
import type { GroundedPoint } from "./executor";
import type { Intent } from "./intent";
import { checkCancelled, type Evidence, type VerificationServices } from "./verification";
import { crossCheck, isVisualMethod, maskCovers, passThrough, uniqueMask, type VisualGrounders, type VisualPoint } from "./visual-grounding";

export interface GateResult { allowed: boolean; evidence: Evidence[] }
const same = (a: PageControl, b: PageControl) =>
  a.name === b.name && a.role === b.role && a.tag === b.tag && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const contains = (control: PageControl, point: GroundedPoint) => point.x >= control.x && point.x < control.x + control.width && point.y >= control.y && point.y < control.y + control.height;
const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
// Keys that only move focus or the view. The desktop worker still refuses them while a sensitive field has focus.
const NAVIGATION_KEYS = new Set(["Escape", "Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export async function confidenceGate(input: {
  intent: Intent; point: GroundedPoint | null; before: Screenshot; snapshot: PageSnapshot | null;
  desktop: DesktopPort; services: VerificationServices; signal?: AbortSignal;
  // Visual grounding (rungs 3-4). `irreversible` is the code-made risk class (send, delete, purchase, ...).
  visual?: VisualGrounders; irreversible?: boolean;
  // ADR-041. The keyboard is on a window outside the browser, so the page list says nothing about the target.
  outsideBrowser?: boolean;
}): Promise<GateResult> {
  const { intent, point, before, snapshot, desktop, services, signal } = input;
  const evidence: Evidence[] = [];
  const deny = (code: string): GateResult => ({ allowed: false, evidence: [...evidence, { method: "page_structure", status: "unknown", code }] });
  checkCancelled(signal);
  if (!["click", "click_at", "drag_at", "scroll_at", "select", "type", "key"].includes(intent.action)) return { allowed: true, evidence };
  if (intent.action === "click_at" || intent.action === "drag_at" || intent.action === "scroll_at") {
    if (!point) return deny("target_not_found");
    if (!input.outsideBrowser && (snapshot?.paymentFrames ?? 0) > 0) return deny("payment_frame_present");
    if (input.irreversible) {
      // ADR-041. The model's own coordinates never count: SAM and computer use must both land on the same control as the point.
      const { sam, computer } = input.visual ?? {};
      if (!sam || !computer) return deny("second_method_unavailable");
      const masks = await sam.masks(before, intent.target).catch((error) => { if (passThrough(error)) throw error; return []; });
      const mask = uniqueMask(masks);
      if (!mask || !maskCovers(mask, point)) return deny("target_mask_disagreement");
      evidence.push({ method: "sam", status: "pass", code: "target_mask_agreement" });
      const second = await crossCheck({ ...point, method: "sam", mask }, intent.target, before, { computer });
      if (second) evidence.push(second);
      return { allowed: second?.status === "pass", evidence };
    }
    // A routine screen action. Asking a model about the model's own pixel adds no independent evidence, only cost and false
    // refusals; the worker still refuses sensitive fields, and the next screenshot shows what happened.
    // ADR-042. The receipt says when the provider asked for a review that the owner's Computer use switch stood in for.
    return { allowed: true, evidence: [point.providerReviewWaived
      ? { method: "computer_use", status: "unknown", code: "provider_review_waived_by_owner" }
      : { method: "page_structure", status: "unknown", code: "screen_point" }] };
  }
  if (input.outsideBrowser && !input.irreversible && (intent.action === "type" || intent.action === "key")) {
    // The desktop worker decides from the real active window, and refuses a terminal without the shell permission.
    return { allowed: true, evidence: [{ method: "page_structure", status: "unknown", code: "outside_browser" }] };
  }
  if (intent.action === "click" && point && isVisualMethod(point.method)) {
    // A pixel click needs a second, independent agreement. Irreversible actions need two agreeing location methods
    // (SAM mask + native computer use); anything else may use the model's pixel check as the second method.
    if (snapshot && (snapshot.paymentFrames ?? 0) > 0) return deny("payment_frame_present");
    evidence.push({ method: point.method as Evidence["method"], status: "pass", code: "visual_target" });
    const second = await crossCheck(point as VisualPoint, intent.target, before, input.visual ?? {});
    if (second) evidence.push(second);
    let agreed = second?.status === "pass";
    if (!agreed && !input.irreversible && services.visual.confirmPoint) {
      const status = await services.visual.confirmPoint(before, intent.target, point);
      agreed = status === "pass";
      evidence.push({ method: "model", status, code: agreed ? "target_point_confirmed" : "target_point_unconfirmed" });
    }
    if (!agreed) return { allowed: false, evidence: input.irreversible && !second ? [...evidence, { method: "model", status: "unknown", code: "second_method_unavailable" }] : evidence };
    checkCancelled(signal);
    const fresh = await desktop.snapshot();
    if (snapshot && (!fresh || fresh.href !== snapshot.href)) return deny("target_changed");
    checkCancelled(signal);
    return { allowed: true, evidence };
  }
  if (intent.action === "key" && !input.irreversible && NAVIGATION_KEYS.has(intent.keys)) {
    return { allowed: true, evidence: [{ method: "page_structure", status: "pass", code: "navigation_key" }] };
  }
  // Routine typing and keys: the desktop worker reads the real focus immediately before the input and refuses a sensitive
  // or unknown target, so a second opinion from here could only refuse fields this list cannot name.
  if (!input.irreversible && (intent.action === "type" || intent.action === "key")) {
    return { allowed: true, evidence: [{ method: "page_structure", status: "unknown", code: "worker_checks_focus" }] };
  }
  if (!snapshot) return deny("unreadable_page");
  const targeted = intent.action === "click" || intent.action === "select";
  const pickedByRef = targeted && point?.ref !== undefined;
  const targets = snapshot.controls.filter((item) => pickedByRef ? item.ref === point!.ref && item.name === point!.name && item.role === point!.role
    : targeted ? point && contains(item, point) && item.name === point.name && item.role === point.role : item.focused === true);
  // A routine control picked by its list number needs no name: icon buttons often have none.
  if (targets.length !== 1 || (!targets[0].name && (input.irreversible || !pickedByRef))) return deny("ambiguous_target");
  const target = targets[0];
  // A list number or the keyboard focus identifies one control among same-named ones. Two pixel-level methods cannot
  // tell such controls apart, so an irreversible action still needs a name that is unique on the page.
  const needsUniqueName = input.irreversible || (targeted && !pickedByRef);
  const nameIsShared = (controls: readonly PageControl[]) => controls.filter((item) => item.name === target.name && item.role === target.role).length !== 1;
  if (needsUniqueName && nameIsShared(snapshot.controls)) return deny("ambiguous_target");
  // A control focused in a background tab does not prove the X keyboard is addressed to the page.
  // takeSnapshot only marks focused when document.hasFocus() is also true.
  if (intent.action === "type" && !["textbox", "searchbox", "combobox", "spinbutton"].includes(target.role)) return deny("unsupported_focus");
  evidence.push({ method: "page_structure", status: "pass", code: "unique_target" });
  // ADR-008 asks two agreeing methods of irreversible steps only. A routine step stands on page structure and goes on to the
  // fresh-snapshot recheck below; a model call here cost a request per step and refused correct clicks.
  let independent = !input.irreversible;
  if (input.irreversible && intent.action === "click" && services.samState === "on" && services.sam) {
    try {
      const masks = await services.sam.masks(before, target.name);
      const matches = masks.filter((mask) => {
        if (mask.confidence === null || mask.confidence < 0.90 || !point) return false;
        const x = point.x - mask.box.x1, y = point.y - mask.box.y1;
        const overlap = Math.max(0, Math.min(target.x + target.width, mask.box.x2 + 1) - Math.max(target.x, mask.box.x1)) * Math.max(0, Math.min(target.y + target.height, mask.box.y2 + 1) - Math.max(target.y, mask.box.y1));
        const union = target.width * target.height + mask.width * mask.height - overlap;
        return x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.raster[y * mask.width + x] === 1 && union > 0 && overlap / union >= 0.5;
      });
      independent = matches.length === 1 && masks.length === 1;
      evidence.push({ method: "sam", status: independent ? "pass" : "unknown", code: independent ? "target_mask_agreement" : "ambiguous_or_missing_mask" });
    } catch { checkCancelled(signal); evidence.push({ method: "sam", status: "unknown", code: "sam_unavailable" }); }
  }
  if (!independent) {
    // No DOM answer hints: the observer must identify the target from the screenshot and original intent.
    const description = JSON.stringify(intent.action === "click" ? { action: "click", target: intent.target }
      : intent.action === "select" ? { action: "select", target: intent.target }
      : intent.action === "key" ? { action: "key", keys: intent.keys } : { action: "type", chars: intent.action === "type" ? intent.text.length : 0 });
    const observed = await services.visual.observe(before, description);
    let agreed = observed.status === "pass" && normalize(observed.name) === normalize(target.name) && normalize(observed.role) === normalize(target.role);
    evidence.push({ method: "model", status: agreed ? "pass" : observed.status === "fail" ? "fail" : "unknown", code: agreed ? "target_visual_agreement" : "target_visual_disagreement" });
    // An observer rarely repeats an accessible name letter for letter. Unless it refused outright, ask the sharper question:
    // does the control page structure found sit under this pixel? A pass is the second agreeing method.
    if (!agreed && observed.status !== "fail" && point && intent.action === "click" && services.visual.confirmPoint) {
      const status = await services.visual.confirmPoint(before, target.name, point);
      agreed = status === "pass";
      evidence.push({ method: "model", status, code: agreed ? "target_point_confirmed" : "target_point_unconfirmed" });
    }
    independent = agreed;
  }
  if (!independent) return { allowed: false, evidence };
  checkCancelled(signal);
  const fresh = await desktop.snapshot();
  if (!fresh) return deny("unreadable_page");
  const matches = fresh.controls.filter((item) => same(target, item) && (targeted || item.focused === true));
  if (fresh.href !== snapshot.href || matches.length !== 1 || (needsUniqueName && nameIsShared(fresh.controls))) return deny("target_changed");
  checkCancelled(signal);
  return { allowed: true, evidence };
}
