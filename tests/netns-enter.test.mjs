import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import test from "node:test";

const helper = path.resolve("docker/desktop/netns-enter.py");

function python() {
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return command;
  }
  return null;
}

test("the namespace helper is present and readable", () => {
  accessSync(helper, constants.R_OK);
});

test("the helper refuses missing or malformed arguments before touching namespaces", { skip: !python() && "python is not available" }, () => {
  const interpreter = python();
  for (const args of [[], ["--"], ["--agent-dir"], ["--agent-dir", "/tmp"]]) {
    const result = spawnSync(interpreter, [helper, ...args], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 111, JSON.stringify(args));
    assert.match(result.stderr, /^netns_invalid_arguments$/m);
  }
});

test("the helper only enters namespaces on a non-root Linux process", { skip: (process.platform !== "linux" || !python()) && "Linux and python are required" }, () => {
  if (process.getuid?.() === 0) return;
  const result = spawnSync(python(), [helper, "--", "/bin/true"], { encoding: "utf8", timeout: 10_000 });
  // Either the namespace was created (status 0) or the host refused it with a fixed code. Never a raw traceback.
  assert.equal(result.stderr.includes("Traceback"), false);
  if (result.status !== 0) assert.match(result.stderr, /^netns_[a-z_]+$/m);
});
