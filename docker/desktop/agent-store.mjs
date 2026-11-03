import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, lstat, mkdir, chown, chmod, readFile, readdir, rename, rm, unlink, symlink, readlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const SYSTEM = "/workspace/.system";
const REGISTRY = `${SYSTEM}/agents.json`;
const RUNTIME = "/run/eclipse";
const NS_ROOT = "/run/eclipse-ns";
const LOCK = `${RUNTIME}/agents.lock`;
export const ADMIN_MASK = 0x1c3n; // CHOWN, DAC_OVERRIDE, SETGID, SETUID, SETPCAP.
const INITIAL_MASK = ADMIN_MASK | (1n << 21n);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const NETNS_HELPER = "/opt/eclipse/desktop/netns-enter.py";
export function nsDirectory(agentId) {
  if (typeof agentId !== "string" || !uuid.test(agentId)) throw new AgentError("invalid_identity");
  return `${NS_ROOT}/${agentId}`;
}
async function ensureNsRoot() {
  let stat;
  try { stat = await lstat(NS_ROOT); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(NS_ROOT, { mode: 0o711 }); await chmod(NS_ROOT, 0o711); await chown(NS_ROOT, 0, 0);
    stat = await lstat(NS_ROOT);
  }
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === 0o711, "unsafe_namespace_directory");
}
export async function ensureNsDirectory(record) {
  const directory = nsDirectory(record.agentId);
  await ensureNsRoot();
  let stat;
  try { stat = await lstat(directory); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700); await chown(directory, record.uid, record.gid);
    stat = await lstat(directory);
  }
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === record.uid && stat.gid === record.gid && (stat.mode & 0o7777) === 0o700, "unsafe_namespace_directory");
  return directory;
}
export class AgentError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (ok, code) => { if (!ok) throw new AgentError(code); };
export function validateIds(ownerId, agentId) {
  check(typeof ownerId === "string" && uuid.test(ownerId) && typeof agentId === "string" && uuid.test(agentId), "invalid_identity");
  return { ownerId, agentId };
}
export function validateRegistry(value) {
  check(value && Object.keys(value).sort().join() === "agents,version" && value.version === 1 && Array.isArray(value.agents) && value.agents.length <= 40000, "invalid_registry");
  const ids = new Set(); const uids = new Set();
  for (const record of value.agents) {
    validateIds(record.ownerId, record.agentId);
    check(Object.keys(record).sort().join() === "agentId,gid,name,ownerId,state,uid" && Number.isInteger(record.uid) && record.uid >= 20000 && record.uid <= 59999 &&
      record.gid === record.uid && record.name === `ec_${record.uid}` && ["pending", "ready", "deleting"].includes(record.state) &&
      !ids.has(record.agentId) && !uids.has(record.uid), "invalid_registry");
    ids.add(record.agentId); uids.add(record.uid);
  }
  return value;
}
export async function requireAdmin({ bootstrap = false } = {}) {
  check(process.getuid?.() === 0 && process.getgid?.() === 0, "admin_identity_required");
  const status = await readFile("/proc/self/status", "utf8");
  const field = (name) => new RegExp(`^${name}:\\s+(\\w+)`, "m").exec(status)?.[1];
  const mask = bootstrap ? INITIAL_MASK : ADMIN_MASK;
  for (const name of ["CapEff", "CapPrm", "CapBnd"]) check(BigInt(`0x${field(name)}`) === mask, "admin_capabilities_invalid");
  for (const name of ["CapInh", "CapAmb"]) check(BigInt(`0x${field(name)}`) === 0n, "admin_capabilities_invalid");
  check(field("NoNewPrivs") === "1" && field("Seccomp") === "2", "admin_security_invalid");
  if (!bootstrap) check(+field("Seccomp_filters") >= 2, "admin_security_invalid");
}
async function directory(name, mode, uid = 0, create = false) {
  let fresh = false;
  try { await lstat(name); } catch (error) {
    if (error.code !== "ENOENT" || !create) throw new AgentError("unsafe_directory");
    await mkdir(name, { mode }); fresh = true;
  }
  if (fresh) { await chmod(name, mode); await chown(name, uid, uid); }
  const stat = await lstat(name);
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && stat.gid === uid && (stat.mode & 0o7777) === mode, "unsafe_directory");
}
async function protectedFile(name, maximum = 4 * 1024 * 1024) {
  const file = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1 && stat.size <= maximum, "unsafe_registry");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
export async function readRegistry() {
  await directory(SYSTEM, 0o700);
  let text;
  try { text = await protectedFile(REGISTRY); } catch (error) {
    if (error.code === "ENOENT") return { version: 1, agents: [] }; throw error;
  }
  try { return validateRegistry(JSON.parse(text)); } catch { throw new AgentError("invalid_registry"); }
}
export async function writeRegistryFile(value, target = REGISTRY) {
  validateRegistry(value);
  check(path.basename(target) === "agents.json", "invalid_registry_path");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
  } catch (error) {
    if (created) {
      try { await unlink(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    }
    throw error;
  }
}
async function saveRegistry(value) {
  await writeRegistryFile(value);
  const parent = await open(SYSTEM, "r"); try { await parent.sync(); } finally { await parent.close(); }
}
async function locked(fn) {
  let lock;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { lock = await open(LOCK, "wx", 0o600); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 39) throw new AgentError("provisioning_locked");
      await delay(50);
    }
  }
  try { return await fn(); } finally { await lock.close(); await unlink(LOCK); }
}
async function bases() {
  const passwd = await readFile("/opt/eclipse/desktop/base-passwd", "utf8");
  const group = await readFile("/opt/eclipse/desktop/base-group", "utf8");
  const users = passwd.trim().split("\n").map((line) => line.split(":"));
  const groups = group.trim().split("\n").map((line) => line.split(":"));
  check(users.every((row) => row.length === 7) && groups.every((row) => row.length === 4), "invalid_base_accounts");
  return { passwd, group, users, groups };
}
const paths = (record) => ({ home: `/workspace/homes/${record.agentId}`, downloads: `/downloads/${record.agentId}` });
export function deletionPaths(record) {
  validateIds(record.ownerId, record.agentId);
  check(Number.isInteger(record.uid) && record.uid >= 20000 && record.uid <= 59999 && record.gid === record.uid &&
    record.name === `ec_${record.uid}`, "invalid_identity");
  return {
    home: `/workspace/homes/${record.agentId}`,
    downloads: `${SYSTEM}/downloads/${record.agentId}`,
    downloadsView: `/downloads/${record.agentId}`,
    ns: nsDirectory(record.agentId),
  };
}
function accountLines(record) {
  const { home } = paths(record);
  return { passwd: `${record.name}:!:${record.uid}:${record.gid}:Eclipse agent:${home}:/bin/bash\n`, group: `${record.name}:!:${record.gid}:\n` };
}
function noCollision(record, base) {
  check(!base.users.some((row) => row[0] === record.name || +row[2] === record.uid) &&
    !base.groups.some((row) => row[0] === record.name || +row[2] === record.gid), "identity_collision");
}
async function layout(record, create = false) {
  const { home, downloads } = paths(record);
  await directory("/workspace/homes", 0o755);
  await directory(`${SYSTEM}/downloads`, 0o755);
  await directory(home, 0o700, record.uid, create);
  for (const suffix of ["inbox", "outbox", "work", ".config", ".config/chromium", ".config/chrome-for-testing"]) await directory(`${home}/${suffix}`, 0o700, record.uid, create);
  await directory(`${SYSTEM}/downloads/${record.agentId}`, 0o700, record.uid, create);
  const link = `${home}/Downloads`;
  try {
    const stat = await lstat(link);
    check(stat.isSymbolicLink() && stat.uid === record.uid && await readlink(link) === downloads, "downloads_alias_changed");
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    await symlink(downloads, link);
    const { lchown } = await import("node:fs/promises"); await lchown(link, record.uid, record.gid);
  }
  await directory(downloads, 0o700, record.uid);
  await ensureNsDirectory(record);
}
export async function removeNsDirectory(record) {
  const directory = nsDirectory(record.agentId);
  await validateDeletableDirectory(directory, record);
  await removeOwnedDirectory(directory, record);
}

export async function restoreAccounts() {
  await requireAdmin({ bootstrap: true });
  const registry = await readRegistry(); const base = await bases();
  let passwd = base.passwd; let group = base.group;
  for (const record of registry.agents) {
    noCollision(record, base);
    if (record.state === "ready") { await layout(record); const lines = accountLines(record); passwd += lines.passwd; group += lines.group; }
  }
  for (const [name, text] of [["passwd", passwd], ["group", group]]) {
    const file = await open(`${RUNTIME}/${name}`, "wx", 0o644);
    try { await file.chmod(0o644); await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  }
  return registry.agents.filter((record) => record.state === "ready").length;
}
async function publishAccount(record) {
  const lines = accountLines(record);
  for (const kind of ["passwd", "group"]) {
    const file = await open(`${RUNTIME}/${kind}`, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(); check(stat.isFile() && stat.uid === 0 && (stat.mode & 0o7777) === 0o644 && stat.size < 8 * 1024 * 1024, "unsafe_account_view");
      const text = await file.readFile("utf8"); const existing = text.split("\n").filter((line) => line.startsWith(`${record.name}:`));
      check(existing.length <= 1 && (!existing.length || `${existing[0]}\n` === lines[kind]), "identity_collision");
      if (!existing.length) {
        const result = await file.write(lines[kind], null, "utf8");
        check(result.bytesWritten === Buffer.byteLength(lines[kind]), "account_write_failed"); await file.sync();
      }
    } finally { await file.close(); }
  }
}
async function unpublishAccount(record) {
  const lines = accountLines(record);
  for (const kind of ["passwd", "group"]) {
    const file = await open(`${RUNTIME}/${kind}`, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(); check(stat.isFile() && stat.uid === 0 && (stat.mode & 0o7777) === 0o644 && stat.size < 8 * 1024 * 1024, "unsafe_account_view");
      const text = await file.readFile("utf8"); const all = text.split("\n").filter(Boolean);
      const existing = all.filter((line) => line.startsWith(`${record.name}:`));
      check(existing.length <= 1 && (!existing.length || `${existing[0]}\n` === lines[kind]), "identity_collision");
      if (!existing.length) continue;
      const remaining = all.filter((line) => !line.startsWith(`${record.name}:`)).join("\n");
      const replacement = remaining ? `${remaining}\n` : "";
      if (replacement) {
        const result = await file.write(replacement, 0, "utf8");
        check(result.bytesWritten === Buffer.byteLength(replacement), "account_write_failed");
      }
      await file.truncate(Buffer.byteLength(replacement));
      await file.sync();
    } finally { await file.close(); }
  }
}
export async function hasAgentProcess(uid, { procRoot = "/proc", readStatus = readFile } = {}) {
  let entries;
  try { entries = await readdir(procRoot); } catch { throw new AgentError("process_scan_failed"); }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const status = await readStatus(path.join(procRoot, entry, "status"), "utf8");
      const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      const state = /^State:\s+(\S)/m.exec(status)?.[1];
      if (!owner || !state) throw new AgentError("process_scan_failed");
      if (Number(owner) === uid && state !== "Z") return true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw new AgentError("process_scan_failed");
    }
  }
  return false;
}
async function validateDeletableDirectory(name, record) {
  let stat;
  try { stat = await lstat(name); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === record.uid && stat.gid === record.gid &&
    (stat.mode & 0o7777) === 0o700, "unsafe_delete_path");
}
async function removeOwnedDirectory(name, record) {
  await validateDeletableDirectory(name, record);
  try { await rm(name, { recursive: true, force: false, maxRetries: 2 }); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
export async function deleteAgent(ownerId, agentId) {
  validateIds(ownerId, agentId); await requireAdmin();
  return locked(async () => {
    const registry = await readRegistry();
    const record = registry.agents.find((item) => item.agentId === agentId);
    if (!record) return { agentId, deleted: false };
    check(record.ownerId === ownerId, "owner_mismatch");
    const targets = deletionPaths(record);
    check(await hasAgentProcess(record.uid) === false, "agent_processes_running");
    await validateDeletableDirectory(targets.home, record);
    await validateDeletableDirectory(targets.downloads, record);
    await validateDeletableDirectory(targets.downloadsView, record);
    await validateDeletableDirectory(targets.ns, record);
    if (record.state !== "deleting") {
      record.state = "deleting";
      await saveRegistry(registry);
    }
    await removeOwnedDirectory(targets.home, record);
    await removeOwnedDirectory(targets.downloads, record);
    await removeOwnedDirectory(targets.downloadsView, record);
    await removeOwnedDirectory(targets.ns, record);
    await unpublishAccount(record);
    registry.agents = registry.agents.filter((item) => item.agentId !== agentId);
    await saveRegistry(registry);
    return { agentId, deleted: true };
  });
}
export async function createAgent(ownerId, agentId) {
  validateIds(ownerId, agentId); await requireAdmin();
  return locked(async () => {
    const registry = await readRegistry(); const base = await bases();
    let record = registry.agents.find((item) => item.agentId === agentId);
    if (record) {
      check(record.ownerId === ownerId, "owner_mismatch");
      check(record.state !== "deleting", "agent_deleting");
    } else {
      const used = new Set([...registry.agents.map((item) => item.uid), ...base.users.map((row) => +row[2]), ...base.groups.map((row) => +row[2])]);
      let uid = 20000; while (used.has(uid) && uid <= 59999) uid++;
      check(uid <= 59999, "identity_range_exhausted");
      record = { ownerId, agentId, uid, gid: uid, name: `ec_${uid}`, state: "pending" };
      noCollision(record, base); registry.agents.push(record); await saveRegistry(registry);
    }
    noCollision(record, base);
    await layout(record, record.state === "pending"); await publishAccount(record);
    if (record.state !== "ready") { record.state = "ready"; await saveRegistry(registry); }
    return { ...record, ...paths(record) };
  });
}
export async function inspectAgent(ownerId, agentId) {
  validateIds(ownerId, agentId); await requireAdmin();
  return locked(async () => {
    const record = (await readRegistry()).agents.find((item) => item.agentId === agentId);
    check(record && record.ownerId === ownerId, "agent_unavailable"); check(record.state === "ready", "agent_not_ready");
    await layout(record); return { ...record, ...paths(record) };
  });
}
export function launchAgent(record, argv, options = {}) {
  validateIds(record.ownerId, record.agentId);
  check(Number.isInteger(record.uid) && record.uid >= 20000 && record.uid <= 59999 && record.gid === record.uid && record.home === `/workspace/homes/${record.agentId}`, "invalid_identity");
  const { extraEnv, ...spawnOptions } = options;
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: record.home, USER: record.name, LOGNAME: record.name, LANG: "C.UTF-8", TMPDIR: `${record.home}/work` };
  if (extraEnv !== undefined) {
    check(extraEnv && typeof extraEnv === "object" && !Array.isArray(extraEnv) && Object.entries(extraEnv).every(([key, value]) => key === "ECLIPSE_FIXTURES" && value === "1"), "invalid_identity");
    Object.assign(env, extraEnv);
  }
  return spawn("/usr/bin/setpriv", ["--reuid", String(record.uid), "--regid", String(record.gid), "--clear-groups", "--bounding-set=-all",
    "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "python3", NETNS_HELPER, "--agent-dir", nsDirectory(record.agentId), "--", ...argv], { ...spawnOptions,
    cwd: record.home, shell: false, env });
}
export async function executeAgent(ownerId, agentId, argv) {
  check(Array.isArray(argv) && argv.length > 0 && argv.length <= 128 && argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    argv.join(" ").length <= 16384, "invalid_command");
  const record = await inspectAgent(ownerId, agentId);
  return new Promise((resolve, reject) => {
    const child = launchAgent(record, ["/usr/bin/timeout", "--kill-after=2s", "60s", ...argv], { stdio: "inherit" });
    child.once("error", () => reject(new AgentError("agent_exec_failed")));
    child.once("close", (code) => resolve(Number.isInteger(code) ? code : 1));
  });
}
