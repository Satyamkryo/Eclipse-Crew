import { z } from "zod";

// TASK-075. Composio REST shapes. Only the fields this app uses are kept; anything else is ignored or rejected by the
// caller with `composio_unexpected_reply`.
export const COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_HOST = "backend.composio.dev";
export const COMPOSIO_TOOLKIT = /^[a-z0-9_]{2,40}$/;
export const COMPOSIO_SLUG = /^[A-Z][A-Z0-9_]{1,80}$/;
export const COMPOSIO_MAX_TOOLS = 500;

export const composioToolSchema = z.object({
  slug: z.string().regex(COMPOSIO_SLUG),
  name: z.string().max(200).optional(),
  description: z.string().max(4096).optional(),
  input_parameters: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  version: z.string().max(64).optional(),
  is_deprecated: z.boolean().optional(),
  toolkit: z.object({ slug: z.string().max(40).optional(), name: z.string().max(200).optional() }).passthrough().optional(),
}).passthrough();

export type ComposioTool = z.infer<typeof composioToolSchema>;

export const pinnedComposioToolSchema = z.object({
  slug: z.string().regex(COMPOSIO_SLUG),
  name: z.string().max(200),
  description: z.string().max(4096),
  tags: z.array(z.string().max(64)).max(20),
  version: z.string().max(64),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const pinnedComposioToolsSchema = z.array(pinnedComposioToolSchema).max(COMPOSIO_MAX_TOOLS);
export type PinnedComposioTool = z.infer<typeof pinnedComposioToolSchema>;

export const sessionReplySchema = z.object({ session_id: z.string().min(1).max(200) }).passthrough();
export const toolsReplySchema = z.object({
  items: z.array(composioToolSchema).max(1000),
  next_cursor: z.string().max(200).nullable().optional(),
  total_pages: z.number().int().min(0).max(10_000).optional(),
}).passthrough();
export const toolkitsReplySchema = z.object({
  items: z.array(z.object({
    slug: z.string().max(40),
    name: z.string().max(200).optional(),
    is_no_auth: z.boolean().optional(),
    connected_account: z.object({
      id: z.string().max(200),
      status: z.string().max(40),
      user_id: z.string().max(200).optional(),
    }).passthrough().nullable().optional(),
  }).passthrough()).max(200),
}).passthrough();
export const linkReplySchema = z.object({
  connected_account_id: z.string().min(1).max(200),
  redirect_url: z.string().min(1).max(2048),
}).passthrough();
export const executeReplySchema = z.object({
  data: z.unknown().optional(),
  error: z.unknown().optional(),
  log_id: z.string().max(200).optional(),
  result_type: z.string().max(40),
  input_requests: z.unknown().optional(),
  request_state: z.unknown().optional(),
  block_reason: z.object({ type: z.string().max(64).optional(), hook_id: z.string().max(64).optional() }).passthrough().optional(),
}).passthrough();

export const composioKeySchema = z.object({
  apiKey: z.union([z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/), z.literal("")]).optional(),
  injectionCheck: z.boolean().optional(),
}).strict().refine((value) => value.apiKey !== undefined || value.injectionCheck !== undefined, { message: "nothing to change" });

export const composioConnectSchema = z.object({
  agentId: z.string().uuid(),
  toolkit: z.string().regex(COMPOSIO_TOOLKIT),
}).strict();

export const composioPinSchema = z.object({
  expectedToolsHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export const COMPOSIO_TOOLKITS = [
  { slug: "gmail", label: "Gmail" },
  { slug: "googlecalendar", label: "Google Calendar" },
  { slug: "googledrive", label: "Google Drive" },
  { slug: "slack", label: "Slack" },
  { slug: "notion", label: "Notion" },
  { slug: "github", label: "GitHub" },
  { slug: "linear", label: "Linear" },
] as const;
