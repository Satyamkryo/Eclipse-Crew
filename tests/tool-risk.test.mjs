import assert from "node:assert/strict";
import test from "node:test";

import { classifyToolCall } from "../lib/tools/risk.ts";
import { splitToolReference } from "../lib/tools/port.ts";

test("tool risk is code-decided from names and annotations", () => {
  for (const name of ["get_me", "list_issues", "search_code", "fetch_file", "read_document"]) {
    assert.equal(classifyToolCall(name, undefined), "none", name);
  }
  assert.equal(classifyToolCall("get_me", { readOnlyHint: true }), "none");
  assert.equal(classifyToolCall("create_issue", undefined), "none");
  assert.equal(classifyToolCall("add_issue_comment", undefined), "none");
  assert.equal(classifyToolCall("create_pull_request", undefined), "none");
  assert.equal(classifyToolCall("create_branch", undefined), "none");
  assert.equal(classifyToolCall("merge_pull_request", undefined), "submit");
  assert.equal(classifyToolCall("delete_repository", undefined), "delete");
  assert.equal(classifyToolCall("archive_repo", undefined), "delete");
  assert.equal(classifyToolCall("transfer_issue", undefined), "delete");
  assert.equal(classifyToolCall("create_or_update_file", undefined), "post");
  assert.equal(classifyToolCall("push_files", undefined), "post");
  assert.equal(classifyToolCall("delete_file", undefined), "post");
  assert.equal(classifyToolCall("update_issue", undefined), "post");
  assert.equal(classifyToolCall("unknown_tool", { readOnlyHint: true }), "none");
  assert.equal(classifyToolCall("unknown_tool", undefined), "post");
  // A read-only hint on a write verb does not make it read-only.
  assert.equal(classifyToolCall("delete_repository", { readOnlyHint: true }), "delete");
});

test("tool references split at the first dot and reject odd names", () => {
  assert.deepEqual(splitToolReference("github.get_me"), { serverKey: "github", tool: "get_me" });
  assert.deepEqual(splitToolReference("work-repo.repo:list"), { serverKey: "work-repo", tool: "repo:list" });
  for (const bad of ["github", ".get_me", "GitHub.get_me", "github.", "github.get me", "g".repeat(33) + ".x"]) {
    assert.equal(splitToolReference(bad), null, bad);
  }
});
