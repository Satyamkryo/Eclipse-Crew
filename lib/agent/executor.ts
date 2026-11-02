import "server-only";
import type { DesktopPort, PageSnapshot, Screenshot } from "./desktop-port";
import type { ClickIntent, Intent } from "./intent";

export interface GroundedPoint {
  x: number;
  y: number;
  method: string;
  // The matched control, when the method found one. Page text, so untrusted.
  role?: string;
  name?: string;
}

// Turns a described target into a screen point (page structure first, see grounding.ts).
// Coordinates only ever come from here, never from the model. `snapshot` is null when the page could not be read.
export interface Grounder {
  ground(intent: ClickIntent, screenshot: Screenshot, snapshot: PageSnapshot | null): Promise<GroundedPoint | null>;
}

export const unavailableGrounder: Grounder = { ground: async () => null };

export function validPoint(point: GroundedPoint | null, screenshot: Screenshot): point is GroundedPoint {
  return Boolean(point) && Number.isInteger(point!.x) && Number.isInteger(point!.y) &&
    point!.x >= 0 && point!.y >= 0 && point!.x < screenshot.width && point!.y < screenshot.height;
}

const SCROLL_COUNT = 3;
const WAIT_MS = 1500;

export async function executeIntent(
  intent: Intent,
  port: DesktopPort,
  point: GroundedPoint | null,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  switch (intent.action) {
    case "click":
      if (!point) throw new Error("ungrounded_click");
      return port.click(point.x, point.y);
    case "type": return port.type(intent.text);
    case "key": return port.key(intent.keys);
    case "scroll": return port.scroll(intent.direction, SCROLL_COUNT);
    case "wait": return sleep(WAIT_MS);
    default: throw new Error("not_executable");
  }
}
