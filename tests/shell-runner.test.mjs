import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { shellEnvironment, runShell } from "../docker/desktop/shell-runner.mjs";
import { shellResultSchema, formatShellResult, checkShellExpect } from "../lib/agent/shell-port.ts";

const HOME = "/workspace/homes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const result = { exit: 0, signal: null, timedOut: false, stdout: "hello", stderr: "", truncated: false, source_tag: "tool", untrusted: true };

test("shell environment carries no secret and points git at the namespace gateway", () => {
  const env = shellEnvironment({ home: HOME, env: { PATH: "/usr/bin", USER: "ec_20000", DESKTOP_CONTROL_SECRET: "canary", EGRESS_DESKTOP_SECRET: "canary" } });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_ASKPASS", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_1", "GIT_TERMINAL_PROMPT", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LOGNAME", "NO_PROXY", "PATH", "TMPDIR", "USER"].sort());
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:3128");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(env.GIT_CONFIG_KEY_0, "url.http://127.0.0.1:3129/git/github.com/.insteadOf");
  assert.equal(env.GIT_CONFIG_VALUE_0, "https://github.com/");
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_1, "");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(JSON.stringify(env).includes("canary"), false);
  assert.equal(Object.values(env).some((value) => String(value).includes("canary")), false);
});

test("shell result formatting and code-checked expectations", () => {
  assert.match(formatShellResult(result), /^exit: 0\nstdout:\nhello$/);
  assert.match(formatShellResult({ ...result, exit: 1, stderr: "bad", truncated: true }), /^exit: 1\nstdout:\nhello\nstderr:\nbad\n\[output truncated\]$/);
  assert.equal(formatShellResult({ ...result, stdout: "x".repeat(20000) }).length, 16000);
  assert.equal(checkShellExpect("exit_code: 0", result), "pass");
  assert.equal(checkShellExpect("exit_code: 7", result), "fail");
  assert.equal(checkShellExpect("stdout_contains: hell", result), "pass");
  assert.equal(checkShellExpect("stdout_contains: nope", result), "fail");
  assert.equal(checkShellExpect("looks right", result), null);
});

test("shell result schema is closed and bounded", () => {
  assert.deepEqual(shellResultSchema.parse(result), result);
  for (const change of [{ extra: true }, { stdout: "x".repeat(16385) }, { source_tag: "browser" }, { untrusted: false }, { exit: 999 }])
    assert.equal(shellResultSchema.safeParse({ ...result, ...change }).success, false);
});

test("shell runner rejects invalid input before spawning", async () => {
  for (const input of [{ command: "" }, { command: "x".repeat(4001) }, { command: "echo\0hi" }, { command: "echo", timeout: 0 }, { command: "echo", timeout: 601 }]) {
    await assert.rejects(runShell({ home: HOME, env: {}, ...input }), (error) => error.code === "shell_invalid");
  }
  await assert.rejects(runShell({ home: HOME, env: {}, command: "echo", cwd: "../../etc" }), (error) => error.code === "shell_cwd_invalid");
});

test("shell runner executes a command as the current user on Linux", { skip: process.platform !== "linux" }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "eclipse-shell-test-"));
  try {
    await mkdir(path.join(home, "work"));
    const output = await runShell({ command: "printf shell-ok", home, env: { PATH: process.env.PATH, USER: "tester" } });
    assert.equal(output.exit, 0);
    assert.equal(output.stdout, "shell-ok");
    assert.equal(output.source_tag, "tool"); assert.equal(output.untrusted, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
