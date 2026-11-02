import type { PinnedComposioTool } from "./schema";

// TASK-075. Client-safe shapes. The key, the Composio key text and connected-account tokens never appear here.
export type ComposioKeyView = { hasKey: boolean; keyHint: string | null; injectionCheck: boolean };

export type ComposioAccountView = {
  id: string;
  agentId: string;
  toolkit: string;
  status: "pending" | "active" | "failed" | "revoked" | "changed";
  toolCount: number;
  toolsHash: string | null;
  pinnedAt: string | null;
};

export type ComposioDiscovery = { toolkit: string; tools: PinnedComposioTool[]; toolsHash: string };
