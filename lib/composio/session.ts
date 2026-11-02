import "server-only";

import type { PinnedComposioTool } from "./schema";

// TASK-075. One session per run, built only from stored state. Composio then enforces our limits too.
export interface SessionAccount {
  toolkit: string;
  connectedAccountId: string;
}

export function buildComposioSession(input: {
  agentId: string;
  accounts: SessionAccount[];
  pinned: PinnedComposioTool[];
  allowedSlugs?: readonly string[];
  injectionCheck: boolean;
  // The link flow targets a toolkit the agent has no account for yet.
  toolkits?: readonly string[];
}) {
  const allowed = input.allowedSlugs ? new Set(input.allowedSlugs) : null;
  const byToolkit = new Map<string, string[]>();
  for (const tool of input.pinned) {
    if (allowed && !allowed.has(tool.slug)) continue;
    const toolkit = tool.slug.split("_")[0].toLowerCase();
    const list = byToolkit.get(toolkit) ?? [];
    list.push(tool.slug);
    byToolkit.set(toolkit, list);
  }
  const toolkits = [...(input.toolkits ?? input.accounts.map((account) => account.toolkit))];
  return {
    user_id: input.agentId,
    toolkits: { enable: toolkits },
    tools: Object.fromEntries(toolkits.map((toolkit) => [toolkit, { enable: (byToolkit.get(toolkit) ?? []).slice(0, 500) }])),
    connected_accounts: Object.fromEntries(input.accounts.map((account) => [account.toolkit, [account.connectedAccountId]])),
    tags: { disable: ["destructiveHint"] },
    manage_connections: { enable: false },
    workbench: { enable: false },
    search: { enable: false },
    execute: { enable_multi_execute: false },
    preload: { tools: "all" },
    instant: false,
    ...(input.injectionCheck ? {
      hooks: [{
        id: "eclipse_injection_check",
        name: "Prompt injection",
        type: "after_execute",
        applies_to: "all",
        handler: { type: "prompt_injection_check", action: "block" },
      }],
    } : {}),
  };
}

export function formatComposioResult(data: unknown): string {
  if (typeof data === "string") return data.slice(0, 16_000);
  try { return JSON.stringify(data ?? null).slice(0, 16_000); } catch { return ""; }
}
