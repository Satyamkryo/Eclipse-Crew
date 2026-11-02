import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

// TASK-073. One shell command as the agent user inside its network namespace. No secrets in the environment, bounded
// output and time, its own process group killed afterwards. Output is untrusted data; the caller tags it `tool`.
const HEAD = 8 * 1024;
const MARKER = "\n[truncated]\n";
const TAIL = 8 * 1024 - MARKER.length;
const OUTPUT_LIMIT = 9 * 1024 * 1024;
let running = false;

const failure = (code) => Object.assign(Error(code), { code });

function collector() {
  const state = { head: "", tail: "", bytes: 0, truncated: false, over: false };
  return {
    push(chunk) {
      const text = chunk.toString("utf8");
      state.bytes += chunk.length;
      if (state.head.length < HEAD) state.head += text.slice(0, HEAD - state.head.length);
      state.tail = (state.tail + text).slice(-TAIL);
      if (state.bytes > OUTPUT_LIMIT) state.over = true;
      if (state.bytes > HEAD) state.truncated = true;
    },
    text() {
      if (!state.truncated) return state.head.slice(0, HEAD);
      return `${state.head}${MARKER}${state.tail}`;
    },
    get truncated() { return state.truncated || state.over; },
    get over() { return state.over; },
  };
}

export function shellEnvironment({ home, env = {} }) {
  return {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, USER: env.USER, LOGNAME: env.LOGNAME ?? env.USER,
    LANG: env.LANG ?? "C.UTF-8", TMPDIR: `${home}/work`,
    HTTPS_PROXY: "http://127.0.0.1:3128", HTTP_PROXY: "http://127.0.0.1:3128", NO_PROXY: "127.0.0.1,localhost",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true", GIT_CONFIG_NOSYSTEM: "1",
    // The gateway is plain HTTP on the namespace loopback; no credential ever reaches the shell.
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "url.http://127.0.0.1:3129/git/github.com/.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "",
    GIT_AUTHOR_NAME: env.USER, GIT_AUTHOR_EMAIL: `${env.USER}@eclipse.local`,
    GIT_COMMITTER_NAME: env.USER, GIT_COMMITTER_EMAIL: `${env.USER}@eclipse.local`,
  };
}

export async function runShell({ command, cwd, timeout = 60, home, env, onSpawn }) {
  if (running) throw failure("shell_busy");
  if (typeof command !== "string" || !command.length || command.length > 4000 || command.includes("\0")) throw failure("shell_invalid");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw failure("shell_invalid");
  if (typeof home !== "string" || !home.startsWith("/")) throw failure("shell_invalid");
  const base = cwd ? path.join(home, cwd) : path.join(home, "work");
  let resolved;
  try { resolved = await realpath(base); } catch { throw failure("shell_cwd_invalid"); }
  if (resolved !== home && !resolved.startsWith(`${home}/`)) throw failure("shell_cwd_invalid");

  const prelude = 'ulimit -u 512 2>/dev/null; ulimit -f 1048576 2>/dev/null; ulimit -v 4194304 2>/dev/null; ulimit -c 0 2>/dev/null; exec bash --noprofile --norc';
  const childEnv = shellEnvironment({ home, env });
  running = true;
  try {
    return await new Promise((resolve) => {
      const child = spawn("setsid", ["timeout", "--kill-after=2s", `${timeout}s`, "bash", "--noprofile", "--norc", "-c", prelude], {
        cwd: resolved, env: childEnv, stdio: ["pipe", "pipe", "pipe"], shell: false,
      });
      child.stdin.on("error", () => {});
      child.stdin.end(`${command}\n`);
      onSpawn?.(child.pid);
      const stdout = collector();
      const stderr = collector();
      let settled = false;
      const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* exited */ } } };
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        child.stdout.destroy();
        child.stderr.destroy();
        killGroup();
        resolve({
          exit: Number.isInteger(code) ? code : 1,
          signal: signal ?? null,
          timedOut: code === 124,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
          source_tag: "tool",
          untrusted: true,
        });
      };
      child.stdout.on("data", (chunk) => { stdout.push(chunk); if (stdout.over) killGroup(); });
      child.stderr.on("data", (chunk) => { stderr.push(chunk); if (stderr.over) killGroup(); });
      child.once("error", () => finish(1, null));
      child.once("close", finish);
    });
  } finally {
    running = false;
  }
}

export function resetShellRunnerForTests() { running = false; }
