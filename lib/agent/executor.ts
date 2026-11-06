import "server-only";
import type { DesktopPort, PageSnapshot, Screenshot } from "./desktop-port";
import type { Intent } from "./intent";

export interface GroundedPoint {
  x: number;
  y: number;
  method: string;
  // The matched control, when the method found one. Page text, so untrusted.
  role?: string;
  name?: string;
  // Set when the model picked the control by its list number, which tells apart controls that share a name.
  ref?: number;
  // ADR-042. The provider asked for a person to confirm this point; the owner's Computer use switch stands in for that.
  providerReviewWaived?: boolean;
}

// Turns a described target into a screen point (page structure first, see grounding.ts).
// Coordinates only ever come from here, never from the model. `snapshot` is null when the page could not be read.
// A click or a select: both name a control in words. Coordinates still come only from code.
export interface GroundTarget { target: string; ref?: number }
export interface Grounder {
  ground(intent: GroundTarget, screenshot: Screenshot, snapshot: PageSnapshot | null): Promise<GroundedPoint | null>;
}

export const unavailableGrounder: Grounder = { ground: async () => null };

export function validPoint(point: GroundedPoint | null, screenshot: Screenshot): point is GroundedPoint {
  return Boolean(point) && Number.isInteger(point!.x) && Number.isInteger(point!.y) &&
    point!.x >= 0 && point!.y >= 0 && point!.x < screenshot.width && point!.y < screenshot.height;
}

const SCROLL_COUNT = 3;
const WAIT_MS = 1500;
export const NAVIGATE_RETRY_MS = 2_000;
const TRANSIENT_NAVIGATION = new Set(["navigation_failed", "uncertain_outcome", "queue_full", "desktop_timeout"]);

function isTransientNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return TRANSIENT_NAVIGATION.has(typeof code === "string" ? code : error.message);
}

export async function executeIntent(
  intent: Intent,
  port: DesktopPort,
  point: GroundedPoint | null,
  sleep: (ms: number) => Promise<void>,
  // ADR-041. Set when the keyboard is on a window outside the browser. `terminal` is the agent's shell permission.
  outside?: { terminal: boolean },
): Promise<void> {
  switch (intent.action) {
    case "click_at":
      if (!point || !port.screenClick) throw new Error("screen_input_unavailable");
      return port.screenClick(point.x, point.y, intent.button ?? "left");
    case "drag_at":
      if (!point || !port.screenDrag) throw new Error("screen_input_unavailable");
      return port.screenDrag(point.x, point.y, intent.to_x, intent.to_y);
    case "scroll_at":
      if (!point || !port.screenScroll) throw new Error("screen_input_unavailable");
      return port.screenScroll(point.x, point.y, intent.direction, SCROLL_COUNT);
    case "click":
      if (!point) throw new Error("ungrounded_click");
      return port.click(point.x, point.y);
    case "select":
      if (!point) throw new Error("ungrounded_select");
      if (!port.select) throw new Error("select_unavailable");
      return port.select(point, intent.option);
    case "navigate": {
      if (!port.navigate) throw new Error("navigate_unavailable");
      // Opening a page is safe to repeat, so one transient failure (a slow first response on a cold browser, a busy
      // desktop queue) gets one more try before the run stops. Any other error, or a second failure, stops as before.
      try {
        return await port.navigate(intent.url);
      } catch (error) {
        if (!isTransientNavigationError(error)) throw error;
        await sleep(NAVIGATE_RETRY_MS);
        return port.navigate(intent.url);
      }
    }
    case "type":
      if (!outside) return port.type(intent.text);
      if (!port.screenType) throw new Error("screen_input_unavailable");
      return port.screenType(intent.text, outside.terminal);
    case "key":
      if (!outside) return port.key(intent.keys);
      if (!port.screenKey) throw new Error("screen_input_unavailable");
      return port.screenKey(intent.keys, outside.terminal);
    case "scroll": return port.scroll(intent.direction, SCROLL_COUNT);
    case "wait": return sleep(WAIT_MS);
    default: throw new Error("not_executable");
  }
}
