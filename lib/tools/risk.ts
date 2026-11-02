import type { RiskClass } from "../agent/risk";
import type { McpAnnotations } from "../mcp/schema";

// TASK-072. Risk is decided by code from the pinned tool metadata, never by the model. Existing action classes only,
// so approvals keep the same vocabulary as clicks. An unknown tool is treated as a write.
const READ_PREFIX = /^(get|list|search|fetch|read|find|retrieve|query)[_.-]/i;
const SAFE_GITHUB_WRITE = /(^|[_.-])(add_issue_comment|create_issue|create_pull_request|create_branch|add_pull_request_review_comment|create_pull_request_review)([_.-]|$)/i;
const MERGE = /merge/i;
const DESTRUCTIVE = /(delete|archive|transfer|remove|destroy|revoke)/i;
const DEFAULT_BRANCH_WRITE = /(create_or_update_file|push_files|delete_file)/i;

export function classifyToolCall(tool: string, annotations: McpAnnotations | undefined): RiskClass {
  if (DEFAULT_BRANCH_WRITE.test(tool)) return "post";
  if (MERGE.test(tool)) return "submit";
  if (SAFE_GITHUB_WRITE.test(tool)) return "none";
  if (DESTRUCTIVE.test(tool) || annotations?.destructiveHint === true) return "delete";
  if (READ_PREFIX.test(tool) || annotations?.readOnlyHint === true) return "none";
  return "post";
}
