import "server-only";

import { z } from "zod";

import { desktopCommand } from "../desktop/client";
import {
  clearPushApprovals, denyPush, fetchPushPending, grantPush,
  type PushDependencies, type PushPending,
} from "../egress/sync";

// TASK-073. The app's only view of the shell. The command runs in the desktop worker's private namespace; this module
// validates its bounded result and nothing else.
export const shellResultSchema = z.object({
  exit: z.number().int().min(-256).max(256),
  signal: z.string().max(32).nullable(),
  timedOut: z.boolean(),
  stdout: z.string().max(16384),
  stderr: z.string().max(16384),
  truncated: z.boolean(),
  source_tag: z.literal("tool"),
  untrusted: z.literal(true),
}).strict();

export type ShellResult = z.infer<typeof shellResultSchema>;

export interface ShellInput {
  command: string;
  cwd?: string;
  timeout?: number;
}

// TASK-073c. A blocked push becomes one pending record per protected ref. The app sees the same
// fields it needs for an approval card and never supplies the gateway's identity itself.
export type { PushPending };

export interface ShellPort {
  run(input: ShellInput, signal?: AbortSignal): Promise<ShellResult>;
  pending(): Promise<PushPending[]>;
  grant(pendingId: string): Promise<void>;
  deny(pendingId: string): Promise<void>;
  clearApprovals(): Promise<void>;
}

const approvalError = () => Object.assign(Error("approval_unavailable"), { code: "approval_unavailable" });

export const SHELL_FAILURE = new Set(["shell_busy", "shell_invalid", "shell_cwd_invalid", "session_not_running", "takeover_active", "sandbox_start_failed"]);

export function createShellPort(options: {
  agentId: string;
  ownerId: string;
  generation?: string;
  // Production: establish or reuse the agent's sandbox and return its current generation. No graphics are needed.
  ensure?: () => Promise<string>;
  command?: typeof desktopCommand;
  // Tests replace these; production uses the authenticated proxy controls.
  dependencies?: PushDependencies;
  pendingCall?: typeof fetchPushPending;
  grantCall?: typeof grantPush;
  denyCall?: typeof denyPush;
  clearCall?: typeof clearPushApprovals;
}): ShellPort {
  const send = options.command ?? desktopCommand;
  const pendingCall = options.pendingCall ?? fetchPushPending;
  const grantCall = options.grantCall ?? grantPush;
  const denyCall = options.denyCall ?? denyPush;
  const clearCall = options.clearCall ?? clearPushApprovals;
  return {
    async run(input) {
      const generation = options.ensure ? await options.ensure() : options.generation;
      if (!generation) throw Object.assign(Error("sandbox_start_failed"), { code: "sandbox_start_failed" });
      const params = {
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.timeout ? { timeout: input.timeout } : {}),
      };
      const raw = await send(options.agentId, options.ownerId, generation, "shell.run", params);
      const parsed = shellResultSchema.safeParse(raw);
      if (!parsed.success) throw Object.assign(Error("shell_invalid_result"), { code: "shell_invalid_result" });
      return parsed.data;
    },
    async pending() {
      const value = await pendingCall(options.agentId, options.dependencies ?? {});
      if (value === null) throw approvalError();
      return value;
    },
    async grant(pendingId) {
      if (!(await grantCall(options.agentId, pendingId, options.dependencies ?? {}))) throw approvalError();
    },
    async deny(pendingId) {
      if (!(await denyCall(options.agentId, pendingId, options.dependencies ?? {}))) throw approvalError();
    },
    async clearApprovals() {
      if (!(await clearCall(options.agentId, options.dependencies ?? {}))) throw approvalError();
    },
  };
}

export function formatShellResult(result: ShellResult): string {
  const parts = [
    `exit: ${result.exit}${result.signal ? ` (signal ${result.signal})` : ""}${result.timedOut ? " (timed out)" : ""}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
    result.truncated ? "[output truncated]" : "",
  ].filter(Boolean).join("\n");
  return parts.slice(0, 16_000);
}

// The two expectation forms code can check. Anything else is the model's unverified claim.
export function checkShellExpect(expect: string, result: ShellResult): "pass" | "fail" | null {
  const exit = /^exit_code:\s*(-?\d{1,3})$/.exec(expect.trim());
  if (exit) return result.exit === Number(exit[1]) ? "pass" : "fail";
  const contains = /^stdout_contains:\s*([\s\S]{1,200})$/.exec(expect.trim());
  if (contains) return result.stdout.includes(contains[1]) ? "pass" : "fail";
  return null;
}
