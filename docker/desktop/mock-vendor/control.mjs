import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, mkdir, unlink, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { startMockVendor } from "./server.mjs";

const SELF = fileURLToPath(import.meta.url);
const stateSchema = z.object({ pid: z.number().int().positive(), birth: z.string().regex(/^\d+$/), uid: z.number().int().min(20000).max(59999),
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/$/) }).strict();

async function privateDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw Error("unsafe_state_directory");
}
export async function processIdentity(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    const latest = await readFile(`/proc/${pid}/stat`, "utf8");
    const current = latest.slice(latest.lastIndexOf(")") + 2).split(" ");
    if (current[19] !== fields[19]) throw Error("process_changed_during_inspection");
    return { pid, birth: current[19], uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]), zombie: current[0] === "Z", cmdline };
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
}
export function sameFixtureProcess(state, identity, self = SELF) {
  return identity && !identity.zombie && identity.uid === state.uid && identity.pid === state.pid && identity.birth === state.birth &&
    identity.cmdline.length === 3 && /(?:^|\/)node$/.test(identity.cmdline[0]) && identity.cmdline[1] === self && identity.cmdline[2] === "serve";
}
async function paths() {
  if (process.platform !== "linux" || process.getuid() < 20000 || process.getuid() > 59999 || process.getuid() !== process.getgid()) throw Error("agent_identity_required");
  const status = await readFile("/proc/self/status", "utf8");
  for (const name of ["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"]) if (!new RegExp(`^${name}:\\s+0+$`, "m").test(status)) throw Error("agent_capabilities_required");
  if (!/^NoNewPrivs:\s+1$/m.test(status)) throw Error("no_new_privileges_required");
  const home = process.env.HOME;
  if (!home || await realpath(home) !== home) throw Error("unsafe_home");
  const work = path.join(home, "work"); await privateDirectory(home); await privateDirectory(work);
  const directory = path.join(work, ".mock-vendor");
  await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  await privateDirectory(directory);
  return { directory, stateFile: path.join(directory, "instance.json"), lockFile: path.join(directory, "control.lock") };
}
async function readState(stateFile) {
  let handle;
  try {
    handle = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 1024) throw Error("unsafe_state");
    const state = stateSchema.parse(JSON.parse(await handle.readFile("utf8")));
    if (state.uid !== process.getuid()) throw Error("wrong_state_owner");
    return state;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { await handle?.close(); }
}
async function writeState(stateFile, state) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state)); await handle.sync(); await handle.close();
    try { await lstat(stateFile); throw Error("state_already_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, stateFile);
  } finally { await handle.close(); await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}
export async function control(command) {
  if (!["start", "status", "stop", "serve"].includes(command)) throw Error("invalid_command");
  const { stateFile, lockFile } = await paths();
  if (command === "serve") {
    const server = await startMockVendor();
    const identity = await processIdentity(process.pid);
    try { await writeState(stateFile, { pid: process.pid, birth: identity.birth, uid: process.getuid(), url: server.url }); }
    catch (error) { await server.close(); throw error; }
    const stop = async () => { await server.close(); process.exit(0); };
    process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
    return;
  }
  const lock = await open(lockFile, "wx", 0o600);
  try {
    let state = await readState(stateFile);
    const identity = state ? await processIdentity(state.pid) : null;
    if (state && identity && !identity.zombie && !sameFixtureProcess(state, identity)) throw Error("ambiguous_process_identity");
    if (state && (!identity || identity.zombie)) { await unlink(stateFile); state = null; }
    if (command === "status") return { state: state ? "running" : "stopped", ...(state ? { url: state.url } : {}) };
    if (command === "stop") {
      if (state) {
        if (!sameFixtureProcess(state, await processIdentity(state.pid))) throw Error("ambiguous_process_identity");
        process.kill(state.pid, "SIGTERM");
        for (let i = 0; i < 60; i++) {
          const current = await processIdentity(state.pid);
          if (!current || current.zombie) { await unlink(stateFile); return { state: "stopped" }; }
          // After our verified SIGTERM, /proc may expose an empty command line
          // just before the process becomes a zombie. Wait; never signal again.
          if (!current.cmdline.length && current.birth === state.birth && current.uid === state.uid) { await delay(100); continue; }
          if (!sameFixtureProcess(state, current)) throw Error("ambiguous_process_identity");
          await delay(100);
        }
        throw Error("fixture_stop_timeout");
      }
      return { state: "stopped" };
    }
    if (state) return { state: "running", url: state.url };
    const child = spawn(process.execPath, [SELF, "serve"], { detached: true, stdio: "ignore", shell: false,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" } });
    let spawnFailed = false; child.once("error", () => { spawnFailed = true; }); child.unref();
    for (let i = 0; i < 60; i++) {
      if (spawnFailed) throw Error("fixture_start_failed");
      state = await readState(stateFile);
      if (state && state.pid === child.pid && sameFixtureProcess(state, await processIdentity(child.pid))) return { state: "running", url: state.url };
      await delay(100);
    }
    throw Error("fixture_start_timeout");
  } finally { await lock.close(); await unlink(lockFile); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    if (process.argv.length !== 3) throw Error("invalid_arguments");
    const result = await control(process.argv[2]);
    if (result) console.log(JSON.stringify(result));
  } catch { console.error('{"error":"mock_vendor_control_refused"}'); process.exitCode = 1; }
}
