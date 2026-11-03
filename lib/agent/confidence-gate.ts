import "server-only";
import type { DesktopPort, PageControl, PageSnapshot, Screenshot } from "./desktop-port";
import type { GroundedPoint } from "./executor";
import type { Intent } from "./intent";
import { checkCancelled, type Evidence, type VerificationServices } from "./verification";

export interface GateResult { allowed: boolean; evidence: Evidence[] }
const same = (a: PageControl, b: PageControl) =>
  a.name === b.name && a.role === b.role && a.tag === b.tag && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const contains = (control: PageControl, point: GroundedPoint) => point.x >= control.x && point.x < control.x + control.width && point.y >= control.y && point.y < control.y + control.height;
const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

export async function confidenceGate(input: {
  intent: Intent; point: GroundedPoint | null; before: Screenshot; snapshot: PageSnapshot | null;
  desktop: DesktopPort; services: VerificationServices; signal?: AbortSignal;
}): Promise<GateResult> {
  const { intent, point, before, snapshot, desktop, services, signal } = input;
  const evidence: Evidence[] = [];
  const deny = (code: string): GateResult => ({ allowed: false, evidence: [...evidence, { method: "page_structure", status: "unknown", code }] });
  checkCancelled(signal);
  if (!["click", "select", "type", "key"].includes(intent.action)) return { allowed: true, evidence };
  if (!snapshot) return deny("unreadable_page");
  const targeted = intent.action === "click" || intent.action === "select";
  const targets = snapshot.controls.filter((item) => targeted ? point && contains(item, point) && item.name === point.name && item.role === point.role : item.focused === true);
  if (targets.length !== 1 || !targets[0].name || snapshot.controls.filter((item) => item.name === targets[0].name && item.role === targets[0].role).length !== 1) return deny("ambiguous_target");
  const target = targets[0];
  // A control focused in a background tab does not prove the X keyboard is addressed to the page.
  // takeSnapshot only marks focused when document.hasFocus() is also true.
  if (intent.action === "type" && !["textbox", "searchbox", "combobox", "spinbutton"].includes(target.role)) return deny("unsupported_focus");
  evidence.push({ method: "page_structure", status: "pass", code: "unique_target" });
  let independent = false;
  if (intent.action === "click" && services.samState === "on" && services.sam) {
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
    independent = observed.status === "pass" && normalize(observed.name) === normalize(target.name) && normalize(observed.role) === normalize(target.role);
    evidence.push({ method: "model", status: independent ? "pass" : observed.status === "fail" ? "fail" : "unknown", code: independent ? "target_visual_agreement" : "target_visual_disagreement" });
  }
  if (!independent) return { allowed: false, evidence };
  checkCancelled(signal);
  const fresh = await desktop.snapshot();
  if (!fresh) return deny("unreadable_page");
  const matches = fresh.controls.filter((item) => same(target, item) && (targeted || item.focused === true));
  if (fresh.href !== snapshot.href || matches.length !== 1 || fresh.controls.filter((item) => item.name === target.name && item.role === target.role).length !== 1) return deny("target_changed");
  checkCancelled(signal);
  return { allowed: true, evidence };
}
