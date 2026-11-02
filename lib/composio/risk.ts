import { createHash } from "node:crypto";

import type { RiskClass } from "../agent/risk";
import type { ComposioTool, PinnedComposioTool } from "./schema";

// TASK-075. Composio's tags are best effort, so the stricter of the tag and the slug verb wins.
const DELETE_VERB = /(^|_)(DELETE|REMOVE|ARCHIVE|TRASH|CANCEL|REVOKE)(_|$)/;
const PURCHASE_VERB = /(^|_)(PAY|CHARGE|PURCHASE|ORDER|BUY)(_|$)/;
const SEND_VERB = /(^|_)(SEND|REPLY|FORWARD)(_|$)/;
const WRITE_VERB = /(^|_)(CREATE|POST|UPDATE|ADD|INSERT|WRITE|EDIT|COMMENT|SHARE)(_|$)/;
const READ_VERB = /(^|_)(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY)(_|$)/;

export function classifyComposioTool(slug: string, tags: readonly string[] = []): RiskClass {
  const action = slug.split("_").slice(1).join("_");
  if (tags.includes("destructiveHint") || DELETE_VERB.test(action)) return "delete";
  if (PURCHASE_VERB.test(action)) return "purchase";
  if (SEND_VERB.test(action)) return "send";
  if (WRITE_VERB.test(action)) return "post";
  if (READ_VERB.test(action)) return "none";
  if (tags.includes("readOnlyHint")) return "none";
  return "post";
}

export function isDestructiveComposioTool(tool: ComposioTool): boolean {
  const action = tool.slug.split("_").slice(1).join("_");
  return tool.tags?.includes("destructiveHint") === true || DELETE_VERB.test(action);
}

function canonical(tool: ComposioTool): string {
  return JSON.stringify({
    slug: tool.slug,
    name: tool.name ?? "",
    description: tool.description ?? "",
    tags: [...(tool.tags ?? [])].sort(),
    version: tool.version ?? "",
    input: tool.input_parameters ?? null,
  });
}

export function composioToolsHash(tools: PinnedComposioTool[]): string {
  return createHash("sha256").update(tools.map((tool) => JSON.stringify({
    slug: tool.slug, name: tool.name, description: tool.description, tags: [...tool.tags].sort(), version: tool.version, hash: tool.hash,
  })).sort().join("\n"), "utf8").digest("hex");
}

export function pinComposioTool(tool: ComposioTool): PinnedComposioTool {
  return {
    slug: tool.slug,
    name: tool.name ?? tool.slug,
    description: (tool.description ?? "").slice(0, 4096),
    tags: [...new Set(tool.tags ?? [])].slice(0, 20),
    version: tool.version ?? "",
    hash: createHash("sha256").update(canonical(tool), "utf8").digest("hex"),
  };
}

export function livePinFromTools(tools: ComposioTool[]): { pinned: PinnedComposioTool[]; hash: string } {
  const pinned = tools.filter((tool) => !isDestructiveComposioTool(tool)).map(pinComposioTool);
  return { pinned, hash: composioToolsHash(pinned) };
}
