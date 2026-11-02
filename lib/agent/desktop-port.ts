import "server-only";
import { z } from "zod";
import {
  desktopCheckpointAside, desktopCheckpointBlob, desktopCheckpointManifest, desktopCheckpointPut, desktopCommand, desktopDeliverFile, desktopListFiles,
  desktopReadFile, pageSnapshotResult, pageVerificationResult,
  type CheckpointEntry, type DeliveredFile, type DocumentWindow, type ListedFile,
} from "../desktop/client";

export type { DeliveredFile, DocumentWindow, ListedFile };

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
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSnapshot {
  href: string;
  title: string;
  // Iframes on the page. Their controls are not listed (top frame only).
  frames: number;
  controls: PageControl[];
}

// The only desktop surface the step loop sees. Each call goes through the guarded controller
// client, so takeover leases, generation checks and owner scoping all still apply.
export interface DesktopPort {
  screenshot(): Promise<Screenshot>;
  snapshot(): Promise<PageSnapshot>;
  verify?(predicate: { kind: "control_present" | "control_absent" | "url_path"; value: string }): Promise<{ status: "pass" | "fail" | "unknown"; code: string }>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(chord: string): Promise<void>;
  scroll(direction: "up" | "down", count: number): Promise<void>;
  // File tools (TASK-067). Optional: a port without them simply offers the model no file actions.
  listFiles?(): Promise<ListedFile[]>;
  readDocument?(name: string, offset: number): Promise<DocumentWindow>;
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

export function createDesktopPort(agentId: string, ownerId: string, generation: string): DesktopPort {
  const run = (operation: string, params: Record<string, unknown>) =>
    desktopCommand(agentId, ownerId, generation, operation, params);
  return {
    async screenshot() {
      const parsed = screenshotResult.parse(await run("capture.screenshot", {}));
      return { base64: parsed.base64, width: parsed.width, height: parsed.height };
    },
    async snapshot() {
      const parsed = pageSnapshotResult.parse(await run("page.snapshot", {}));
      return { href: parsed.href, title: parsed.title, frames: parsed.frames,
        controls: parsed.elements.map(({ ref, role, name, tag, focused, x, y, width, height }) => ({ ref, role, name, tag, ...(focused === undefined ? {} : { focused }), x, y, width, height })) };
    },
    async verify(predicate) { return pageVerificationResult.parse(await run("page.verify", { predicate })); },
    async click(x, y) { await run("input.click", { button: "left", x, y }); },
    async type(text) { await run("input.type", { text }); },
    async key(chord) { await run("input.key", { key: chord }); },
    async scroll(direction, count) { await run("input.scroll", { direction, count }); },
    async listFiles() { return (await desktopListFiles(agentId, ownerId)).files; },
    async readDocument(name, offset) { return desktopReadFile(agentId, ownerId, name, offset); },
    async deliverFile(from, name) { return desktopDeliverFile(agentId, ownerId, from, name); },
    async checkpointManifest() { return desktopCheckpointManifest(agentId, ownerId); },
    async checkpointBlob(file) { return desktopCheckpointBlob(agentId, ownerId, file); },
    async checkpointPut(file, bytes) { await desktopCheckpointPut(agentId, ownerId, file, bytes); },
    async checkpointAside(file) { await desktopCheckpointAside(agentId, ownerId, file); },
  };
}
