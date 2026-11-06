import "server-only";
import { z } from "zod";
import {
  desktopCheckpointAside, desktopCheckpointBlob, desktopCheckpointManifest, desktopCheckpointPut, desktopCommand, desktopDeliverFile, desktopListFiles,
  desktopReadFile, desktopSearchFile, pageSnapshotResult, pageVerificationResult,
  type CheckpointEntry, type DeliveredFile, type DesktopStatus, type DocumentSearchResult, type DocumentWindow, type ListedFile,
} from "../desktop/client";
import type { AgentLifecycle } from "./runtime";

export type { DeliveredFile, DocumentSearchResult, DocumentWindow, ListedFile };

export interface Screenshot {
  base64: string;
  width: number;
  height: number;
}

// One visible control of the focused page. Name and role come from the page, so they are untrusted data.
// x/y/width/height are screen pixels and never reach the model.
export interface PageControl {
  focused?: boolean;
  ref: number;
  role: string;
  name: string;
  tag: string;
  // TASK-084. `child` means the control is inside an iframe; `shadow` means inside an open shadow root.
  frame?: "top" | "child";
  shadow?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSnapshot {
  href: string;
  title: string;
  // Every Playwright frame. Controls inside them are listed (scanner A).
  frames: number;
  // Frames that look like payment frames. Their controls are never listed.
  paymentFrames?: number;
  controls: PageControl[];
}

export type WindowKind = "browser" | "terminal" | "file_manager" | "other" | "none";

// The only desktop surface the step loop sees. Each call goes through the guarded controller
// client, so takeover leases, generation checks and owner scoping all still apply.
export interface DesktopPort {
  // null means the graphical desktop or managed browser is not running; the run may continue without it.
  screenshot(): Promise<Screenshot | null>;
  snapshot(): Promise<PageSnapshot | null>;
  verify?(predicate: { kind: "control_present" | "control_absent" | "url_path"; value: string }): Promise<{ status: "pass" | "fail" | "unknown"; code: string }>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(chord: string): Promise<void>;
  scroll(direction: "up" | "down", count: number): Promise<void>;
  // TASK-084. Optional: a port without them offers no extract, navigate or select action.
  findText?(text: string): Promise<{ found: boolean; count: number }>;
  navigate?(url: string): Promise<void>;
  select?(point: { x: number; y: number }, option: string): Promise<void>;
  // ADR-041. Input outside the page list. A port without them offers no click_at action.
  activeWindow?(): Promise<WindowKind>;
  screenClick?(x: number, y: number, button?: "left" | "right" | "double"): Promise<void>;
  screenDrag?(x: number, y: number, toX: number, toY: number): Promise<void>;
  screenScroll?(x: number, y: number, direction: "up" | "down" | "left" | "right", count: number): Promise<void>;
  screenType?(text: string, terminal: boolean): Promise<void>;
  screenKey?(chord: string, terminal: boolean): Promise<void>;
  // TASK-079. Capture this agent's private speaker; a port without it offers no hearing action.
  captureAudio?(seconds: number): Promise<{ base64: string; durationMs: number }>;
  // Lazy lifecycle: absent only for a port created with a fixed generation (tests and callers that hold one).
  available?(): Promise<boolean>;
  ensureVisual?(): Promise<DesktopStatus>;
  ensureBrowser?(): Promise<DesktopStatus>;
  // File tools (TASK-067). Optional: a port without them simply offers the model no file actions.
  listFiles?(): Promise<ListedFile[]>;
  readDocument?(name: string, offset: number): Promise<DocumentWindow>;
  // TASK-082. Uses the read_document permission: search returns passages of the same text, never the file itself.
  searchDocument?(name: string, query: string): Promise<DocumentSearchResult>;
  deliverFile?(from: "downloads" | "work", name: string): Promise<DeliveredFile>;
  // Per-step checkpoints (TASK-032). Optional: a port without them simply takes no file checkpoints.
  checkpointManifest?(): Promise<{ entries: CheckpointEntry[]; skipped: number }>;
  checkpointBlob?(file: { area: CheckpointEntry["area"]; path: string; sha256: string }): Promise<Buffer>;
  // Rewind restore (TASK-043). Optional: a port without them cannot restore a checkpoint.
  checkpointPut?(file: { area: CheckpointEntry["area"]; path: string; sha256: string; size: number }, bytes: Uint8Array): Promise<void>;
  checkpointAside?(file: { area: CheckpointEntry["area"]; path: string; bucket: string }): Promise<void>;
}

const screenshotResult = z.object({
  width: z.number().int().min(1), height: z.number().int().min(1), base64: z.string().min(1),
}).passthrough();

function buildPort(agentId: string, ownerId: string, resolveGeneration: () => Promise<string>, lifecycle?: AgentLifecycle): DesktopPort {
  const run = async (operation: string, params: Record<string, unknown>) =>
    desktopCommand(agentId, ownerId, await resolveGeneration(), operation, params);
  return {
    async screenshot() {
      const parsed = screenshotResult.parse(await run("capture.screenshot", {}));
      return { base64: parsed.base64, width: parsed.width, height: parsed.height };
    },
    async snapshot() {
      const parsed = pageSnapshotResult.parse(await run("page.snapshot", {}));
      return { href: parsed.href, title: parsed.title, frames: parsed.frames, paymentFrames: parsed.paymentFrames,
        controls: parsed.elements.map(({ ref, role, name, tag, focused, frame, shadow, x, y, width, height }) => ({ ref, role, name, tag,
          ...(focused === undefined ? {} : { focused }), frame, shadow, x, y, width, height })) };
    },
    async verify(predicate) { return pageVerificationResult.parse(await run("page.verify", { predicate })); },
    async click(x, y) { await run("input.click", { button: "left", x, y }); },
    async type(text) { await run("input.type", { text }); },
    async key(chord) { await run("input.key", { key: chord }); },
    async scroll(direction, count) { await run("input.scroll", { direction, count }); },
    async activeWindow() { return (await run("window.active", {}) as { kind: WindowKind }).kind; },
    async screenClick(x, y, button = "left") { await run("input.screen_click", { x, y, button }); },
    async screenDrag(x, y, toX, toY) { await run("input.screen_drag", { x, y, toX, toY }); },
    async screenScroll(x, y, direction, count) { await run("input.screen_scroll", { x, y, direction, count }); },
    async screenType(text, terminal) { await run("input.screen_type", { text, terminal }); },
    async screenKey(chord, terminal) { await run("input.screen_key", { key: chord, terminal }); },
    async findText(text) { const result = await run("page.find_text", { text }); return { found: (result as { found: boolean }).found, count: (result as { count: number }).count }; },
    async navigate(url) { await run("browser.navigate", { url }); },
    async select(point, option) { await run("input.select", { x: point.x, y: point.y, option }); },
    async captureAudio(seconds) {
      const result = await run("audio.capture", { seconds }) as { base64: string; durationMs: number };
      return { base64: result.base64, durationMs: result.durationMs };
    },
    ...(lifecycle ? {
      async available() {
        const status = await lifecycle.status();
        return status.state === "running" && status.graphics === "running" && status.browser === "running";
      },
      ensureVisual: () => lifecycle.ensureDesktop(),
      ensureBrowser: () => lifecycle.ensureBrowser(),
    } : {}),
    async listFiles() { return (await desktopListFiles(agentId, ownerId)).files; },
    async readDocument(name, offset) { return desktopReadFile(agentId, ownerId, name, offset); },
    async searchDocument(name, query) { return desktopSearchFile(agentId, ownerId, name, query); },
    async deliverFile(from, name) { return desktopDeliverFile(agentId, ownerId, from, name); },
    async checkpointManifest() { return desktopCheckpointManifest(agentId, ownerId); },
    async checkpointBlob(file) { return desktopCheckpointBlob(agentId, ownerId, file); },
    async checkpointPut(file, bytes) { await desktopCheckpointPut(agentId, ownerId, file, bytes); },
    async checkpointAside(file) { await desktopCheckpointAside(agentId, ownerId, file); },
  };
}

// A fixed-generation port, used by callers that already own a running session.
export function createDesktopPort(agentId: string, ownerId: string, generation: string): DesktopPort {
  return buildPort(agentId, ownerId, async () => generation);
}

// The production port: each call first ensures the sandbox (or the visual desktop) runs, then uses the current generation.
export function createLazyDesktopPort(agentId: string, ownerId: string, lifecycle: AgentLifecycle): DesktopPort {
  const generation = async () => {
    await lifecycle.ensureSandbox();
    const current = lifecycle.generation();
    if (!current) throw Object.assign(Error("sandbox_start_failed"), { code: "sandbox_start_failed" });
    return current;
  };
  return buildPort(agentId, ownerId, generation, lifecycle);
}
