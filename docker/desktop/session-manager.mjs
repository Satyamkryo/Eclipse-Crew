import net from "node:net";
import { randomUUID } from "node:crypto";
import { operationFields, resultFor } from "./controller-schema.mjs";
import { lstat, chmod, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AgentError, createAgent, deleteAgent, inspectAgent, launchAgent, requireAdmin, validateIds } from "./agent-store.mjs";
import { processIdentity, SESSION_FAILURES } from "./session-worker.mjs";
import { createChannel, writeFramed } from "./controller-channel.mjs";

export const SESSION_SOCKET = "/run/eclipse/sessions.sock";
const COMMANDS = ["session-start", "session-status", "session-stop"];
export function validateSessionRequest(value) {
  if (!value || Object.keys(value).sort().join() !== "agentId,command,ownerId" || !COMMANDS.includes(value.command)) throw new AgentError("invalid_session_request");
  validateIds(value.ownerId, value.agentId); return value;
}
function publicState(record, state = "stopped", extra = {}) {
  return { agentId: record.agentId, state, display: record.uid - 20000 + 100, ...extra };
}
const DUPLICATE_ID_CACHE_LIMIT = 256;


export class SessionManager {
  entries = new Map(); queues = new Map(); closing = false; viewers = new Map(); queued = new Map();
  generations = new Map();   // agentId -> current generation (int)
  requestIds = new Map();    // agentId -> Set of seen requestIds (bounded)
  takeovers = new Map();     // agentId -> { takenOver: boolean }
  serialize(id, fn) {
    const count = this.queued.get(id) ?? 0;
    if (count >= 32) return Promise.reject(new AgentError("queue_full"));
    this.queued.set(id, count + 1);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); const remaining = (this.queued.get(id) ?? 1) - 1; if (remaining) this.queued.set(id, remaining); else this.queued.delete(id); }).catch(() => {}); return next;
  }
  async observe(entry) {
    if (entry.observing) return entry.observing;
    entry.observing = (async () => {
      const visit = async (pid, depth = 0) => {
        if (depth > 12 || entry.tracked.size >= 1024) return;
        const identity = await processIdentity(pid); if (!identity) return;
        if (identity.uid === entry.record.uid) entry.tracked.set(pid, { pid, birth: identity.birth });
        let children; try { children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"); } catch { return; }
        for (const child of children.trim().split(" ").filter(Boolean)) await visit(+child, depth + 1);
      };
      await visit(entry.child.pid);
    })().finally(() => { entry.observing = null; });
    return entry.observing;
  }
  async terminate(entry) {
    // Never grant CAP_KILL. A fixed helper can signal only this agent's verified PID identities.
    const { home: _home, downloads: _downloads, ...identity } = entry.record; void _home; void _downloads;
    await entry.runtimeReady;
    const helper = launchAgent(entry.record, ["node", "/opt/eclipse/desktop/session-worker.mjs", "--terminate", JSON.stringify([...entry.tracked.values()]), JSON.stringify(identity), JSON.stringify(entry.runtime ?? null)], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AgentError("session_cleanup_failed")), 3000);
      helper.once("error", () => { clearTimeout(timer); reject(new AgentError("session_cleanup_failed")); });
      helper.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new AgentError("session_cleanup_failed")); });
    });
    for (const item of entry.tracked.values()) {
      const current = await processIdentity(item.pid);
      if (current && current.birth === item.birth && !current.zombie) throw new AgentError("session_cleanup_failed");
    }
  }
  async clean(entry) {
    if (entry.cleanup) return entry.cleanup;
    const cleanup = (async () => {
      this.closeViewers(entry.record.agentId);
      if (entry.monitor) clearInterval(entry.monitor);
      await this.observe(entry);
      // Send framed stop command to worker via stdin pipe
      if (entry.channel && entry.child.stdin && !entry.child.stdin.destroyed) {
        try { await writeFramed(entry.child.stdin, { command: "stop" }); } catch { /* disconnected */ }
      }
      for (let i = 0; i < 60 && entry.child.exitCode === null && entry.child.signalCode === null; i++) await delay(100);
      await this.terminate(entry);
    })();
    entry.cleanup = cleanup;
    void cleanup.catch(() => { if (entry.cleanup === cleanup) entry.cleanup = null; });
    return cleanup;
  }
  authorize(ownerId, agentId, generation, { running = true } = {}) {
    validateIds(ownerId, agentId);
    const entry = this.entries.get(agentId);
    if (!entry || entry.record.ownerId !== ownerId) throw new AgentError("agent_unavailable");
    if (generation !== undefined && generation !== entry.generation) throw new AgentError("stale_generation");
    if (running && entry.state !== "running") throw new AgentError("session_not_running");
    if (running && entry.uncertain) throw new AgentError("uncertain_outcome");
    return entry;
  }
  state(entry) {
    return { ...publicState(entry.record, entry.state), generation: entry.generation,
      ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.vncPort ? { vncPort: entry.vncPort, vncReady: !!entry.vncReady } : {}), takenOver: !!this.takeovers.get(entry.record.agentId) };
  }
  start(ownerId, agentId) {
    validateIds(ownerId, agentId);
    return this.serialize(agentId, async () => {
      if (this.closing) throw new AgentError("supervisor_stopping");
      const record = await inspectAgent(ownerId, agentId); const old = this.entries.get(agentId);
      if (this.closing) throw new AgentError("supervisor_stopping");
      if (old?.state === "running" && !old.uncertain) return this.state(old);
      if (old) await this.clean(old);
      this.takeovers.delete(agentId); this.requestIds.set(agentId, new Set());
      const { home: _h, downloads: _d, ...identity } = record; void _h; void _d;
      const child = launchAgent(record, ["node", "/opt/eclipse/desktop/session-worker.mjs", JSON.stringify(identity)], { stdio: ["pipe", "pipe", "ignore"] });
      const entry = { record, child, state: "starting", generation: randomUUID(), tracked: new Map() }; this.entries.set(agentId, entry); this.generations.set(agentId, entry.generation);
      entry.monitor = setInterval(() => { void this.observe(entry).catch(() => {}); }, 200);
      let readyResolve, readyReject; const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      entry.cancelStart = () => readyReject(new AgentError("supervisor_stopping"));
      const failed = (code = "session_worker_exited") => {
        readyReject(new AgentError(code));
        if (["stopping", "stopped", "failed"].includes(entry.state)) return;
        entry.state = "failed"; entry.reason = code; this.closeViewers(agentId); void this.clean(entry).catch(() => {});
      };
      const timer = setTimeout(() => failed("session_start_timeout"), 30000);
      child.once("error", () => failed()); child.once("exit", () => failed());
      entry.channel = createChannel(child.stdout, child.stdin, { onEvent: async (message) => {
        if (message.state === "runtime" && typeof message.directory === "string" && new RegExp(`^/tmp/ec-${record.uid}-[a-zA-Z0-9]{6}$`).test(message.directory)) {
          entry.runtimeReady = lstat(message.directory).then((st) => {
            if (!st.isDirectory() || st.uid !== record.uid || (st.mode & 0o7777) !== 0o700) throw Error("unsafe_runtime");
            entry.runtime = { path: message.directory, ino: st.ino, dev: st.dev };
          }); await entry.runtimeReady;
        } else if (message.state === "vnc_ready") {
          if (message.vncPort !== 5950 + record.uid - 20000 || typeof message.password !== "string" || !/^[A-Za-z0-9+/]{8}$/.test(message.password)) throw Error("invalid_vnc_metadata");
          entry.vncPort = message.vncPort; entry.vncPassword = message.password; entry.vncReady = true;
        } else if (message.state === "running" && entry.state === "starting") { entry.state = "running"; readyResolve(); }
        else if (message.state === "failed") failed(SESSION_FAILURES.has(message.reason) ? message.reason : "session_component_failed");
        else throw Error("invalid_worker_event");
      } });
      void entry.channel.done.then(() => failed());
      try { await ready; await this.observe(entry); return this.state(entry); }
      catch (error) { await this.clean(entry); throw error; } finally { clearTimeout(timer); delete entry.cancelStart; }
    });
  }
  create(ownerId, agentId) {
    validateIds(ownerId, agentId);
    return this.serialize(agentId, async () => {
      if (this.closing) throw new AgentError("supervisor_stopping");
      const record = await createAgent(ownerId, agentId);
      return { agentId: record.agentId };
    });
  }
  delete(ownerId, agentId) {
    validateIds(ownerId, agentId);
    return this.serialize(agentId, async () => {
      if (this.closing) throw new AgentError("supervisor_stopping");
      const entry = this.entries.get(agentId);
      if (entry && entry.record.ownerId !== ownerId) throw new AgentError("agent_unavailable");
      if (entry) {
        entry.state = "stopping";
        await this.clean(entry);
        entry.state = "stopped";
      }
      this.closeViewers(agentId);
      this.takeovers.delete(agentId);
      const deleted = await deleteAgent(ownerId, agentId);
      this.entries.delete(agentId);
      this.generations.delete(agentId);
      this.requestIds.delete(agentId);
      return { agentId: deleted.agentId };
    });
  }
  async status(ownerId, agentId) {
    const record = await inspectAgent(ownerId, agentId); const entry = this.entries.get(agentId);
    if (!entry) return publicState(record);
    if (entry.record.ownerId !== ownerId) throw new AgentError("agent_unavailable");
    return this.state(entry);
  }
  stop(ownerId, agentId, generation) {
    validateIds(ownerId, agentId);
    return this.serialize(agentId, async () => {
      const record = await inspectAgent(ownerId, agentId); const entry = this.entries.get(agentId);
      if (entry) { this.authorize(ownerId, agentId, generation, { running: false }); entry.state = "stopping"; await this.clean(entry); entry.state = "stopped"; }
      this.closeViewers(agentId); this.takeovers.delete(agentId); return entry ? this.state(entry) : publicState(record);
    });
  }
  closeViewers(agentId) {
    const viewers = this.viewers.get(agentId); this.viewers.delete(agentId); this.takeovers.delete(agentId);
    for (const viewer of viewers?.values() ?? []) { try { viewer.close(); } catch { /* already disconnected */ } }
  }
  streamInfo(ownerId, agentId, control) {
    const entry = this.authorize(ownerId, agentId, control.generation);
    if (!entry.vncReady || !entry.vncPassword) throw new AgentError("stream_unavailable");
    return { port: entry.vncPort, password: entry.vncPassword };
  }
  registerViewer(ownerId, agentId, control, close) {
    this.streamInfo(ownerId, agentId, control);
    let viewers = this.viewers.get(agentId); if (!viewers) { viewers = new Map(); this.viewers.set(agentId, viewers); }
    if (viewers.size >= 4 || viewers.has(control.connectionId)) throw new AgentError("viewer_limit");
    const viewer = { ...control, ownerId, close }; viewers.set(control.connectionId, viewer);
    return () => {
      if (viewers.get(control.connectionId) !== viewer) return;
      viewers.delete(control.connectionId); if (!viewers.size) this.viewers.delete(agentId);
      const lease = this.takeovers.get(agentId);
      if (lease?.connectionId === control.connectionId && lease.sessionRef === control.sessionRef) this.takeovers.delete(agentId);
    };
  }
  validateViewer(ownerId, agentId, control) {
    this.authorize(ownerId, agentId, control.generation);
    const viewer = this.viewers.get(agentId)?.get(control.connectionId);
    if (!viewer || viewer.ownerId !== ownerId || viewer.generation !== control.generation || viewer.sessionRef !== control.sessionRef) throw new AgentError("viewer_not_active");
  }
  takeOver(ownerId, agentId, control) {
    return this.serialize(agentId, async () => {
      this.validateViewer(ownerId, agentId, control); const lease = this.takeovers.get(agentId);
      if (lease && (lease.connectionId !== control.connectionId || lease.sessionRef !== control.sessionRef)) throw new AgentError("takeover_conflict");
      const current = lease ?? { ownerId, ...control, leaseId: randomUUID() }; this.takeovers.set(agentId, current);
      return { takenOver: true, leaseId: current.leaseId, generation: control.generation };
    });
  }
  handBack(ownerId, agentId, control) {
    return this.serialize(agentId, async () => {
      this.authorize(ownerId, agentId, control.generation); const lease = this.takeovers.get(agentId);
      if (lease && (lease.ownerId !== ownerId || lease.leaseId !== control.leaseId || lease.sessionRef !== control.sessionRef || lease.connectionId !== control.connectionId)) throw new AgentError("invalid_lease");
      this.takeovers.delete(agentId); return { takenOver: false, generation: control.generation };
    });
  }
  remember(agentId, requestId) {
    let ids = this.requestIds.get(agentId); if (!ids) { ids = new Set(); this.requestIds.set(agentId, ids); }
    if (ids.has(requestId)) throw new AgentError("duplicate_request_id");
    ids.add(requestId);
    if (ids.size > DUPLICATE_ID_CACHE_LIMIT) ids.delete(ids.values().next().value);
  }
  async perform(entry, requestId, operation, params) {
    try { const value = await entry.channel.send({ command: "operation", requestId, operation, params }); return resultFor(operation, value, params); }
    catch (error) {
      if (["uncertain_outcome", "channel_closed"].includes(error.code)) {
        entry.uncertain = true; entry.reason = "uncertain_outcome"; entry.state = "failed"; this.closeViewers(entry.record.agentId);
        entry.channel.close(); void this.clean(entry).catch(() => {}); throw new AgentError("uncertain_outcome");
      }
      if (error instanceof AgentError || error.code && /^[a-z_]{1,64}$/.test(error.code)) throw new AgentError(error.code);
      throw new AgentError("invalid_worker_result");
    }
  }
  ownerInput(ownerId, agentId, operation, params, control = params) {
    this.authorize(ownerId, agentId, control.generation);
    return this.serialize(agentId, async () => {
      const entry = this.authorize(ownerId, agentId, control.generation); this.validateViewer(ownerId, agentId, control);
      const lease = this.takeovers.get(agentId);
      if (!lease || lease.ownerId !== ownerId || lease.leaseId !== control.leaseId || lease.sessionRef !== control.sessionRef || lease.connectionId !== control.connectionId) throw new AgentError("not_in_takeover");
      const fields = operationFields({ ...params, operation }); if (!operation.startsWith("input.")) throw new AgentError("capture_blocked_during_takeover");
      this.remember(agentId, control.requestId); return this.perform(entry, control.requestId, operation, fields);
    });
  }
  executeOperation(ownerId, agentId, generation, requestId, operation, params) {
    this.authorize(ownerId, agentId, generation);
    return this.serialize(agentId, async () => {
      const entry = this.authorize(ownerId, agentId, generation);
      if (this.takeovers.has(agentId)) throw new AgentError("takeover_active");
      const fields = operationFields({ ...params, operation }); this.remember(agentId, requestId);
      return this.perform(entry, requestId, operation, fields);
    });
  }
  async closeAll() {
    this.closing = true;
    const results = await Promise.allSettled([...this.entries.values()].map(async (entry) => { entry.cancelStart?.(); entry.state = "stopping"; await this.clean(entry); entry.state = "stopped"; }));
    await Promise.allSettled([...this.queues.values()]);
    if (results.some((result) => result.status === "rejected")) throw new AgentError("session_cleanup_failed");
  }
}
export async function listenSessions(manager) {
  await requireAdmin();
  const parent = await lstat("/run/eclipse");
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o7777) !== 0o700) throw new AgentError("unsafe_control_path");
  const server = net.createServer((socket) => {
    socket.setTimeout(35000, () => socket.destroy()); let bytes = 0; let body = ""; let used = false;
    const respond = (value) => { if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n"); };
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 || used) { socket.destroy(); return; }
      body += chunk.toString("utf8"); if (!body.includes("\n")) return;
      used = true;
      void (async () => {
        try {
          const request = validateSessionRequest(JSON.parse(body));
          const method = { "session-start": "start", "session-status": "status", "session-stop": "stop" }[request.command];
          respond(await manager[method](request.ownerId, request.agentId));
        } catch (error) { respond({ outcome: "refused", reason: error instanceof AgentError ? error.code : "session_request_failed" }); }
      })();
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(SESSION_SOCKET, resolve); });
  await chmod(SESSION_SOCKET, 0o600); return server;
}
export async function requestSession(command, ownerId, agentId) {
  const request = validateSessionRequest({ command, ownerId, agentId }); await requireAdmin();
  const st = await lstat(SESSION_SOCKET);
  if (!st.isSocket() || st.uid !== 0 || (st.mode & 0o7777) !== 0o600) throw new AgentError("unsafe_control_path");
  return new Promise((resolve, reject) => {
    const socket = net.connect(SESSION_SOCKET); let body = "";
    const fail = () => { socket.destroy(); reject(new AgentError("session_control_unavailable")); };
    socket.setTimeout(35000, fail); socket.once("error", fail);
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => { if (body.length + chunk.length > 1024) { fail(); return; } body += chunk.toString("utf8"); });
    socket.once("end", () => {
      try { const value = JSON.parse(body); if (value.outcome === "refused") throw new AgentError(value.reason); resolve(value); } catch (error) { reject(error); }
    });
  });
}
