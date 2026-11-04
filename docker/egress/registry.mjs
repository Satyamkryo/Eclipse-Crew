import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// TASK-045: memory-only per-agent egress policy. The app pushes entries; a restart or a missed
// refresh expires them, so the browser fails closed. No tokens or domains are persisted.
// TASK-047: entries also carry canary hashes (never the canary) and a trip latch with no TTL.

export const POLICY_TTL_MS = 120_000;
export const MAX_TUNNELS_PER_AGENT = 64;
export const MAX_TUNNELS = 256;
export const PENDING_TTL_MS = 15 * 60_000;
export const GRANT_TTL_MS = 10 * 60_000;
export const MAX_PENDING_PER_AGENT = 8;
export const MAX_GRANTS_PER_AGENT = 8;
export const MAX_PENDING = 256;
export const MAX_GRANTS = 256;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OID_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_PART = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const REF = /^refs\/(heads|tags)\/[^\s\0]{1,255}$/;
const KINDS = new Set(["default_branch", "delete", "tag_update"]);
const CLASSES = new Set(["post", "delete"]);
const ACTION_CLASSES = new Set(["download", "send", "post", "delete", "purchase", "submit"]);

export function canonicalDomains(values) {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

export function canonicalHashes(values = []) {
  return [...new Set(values
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase())
    .filter((value) => HASH_PATTERN.test(value)))].sort();
}

export function egressToken(secret, agentId) {
  return createHmac("sha256", secret).update(`v1:${agentId}`).digest("hex");
}

export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || !/^[0-9a-f]{64}$/.test(provided)) return false;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

// TASK-073c. The complete authorization identity. `owner`/`repo` are lowercased; refs are
// case-sensitive; `requestHash` covers every ref command in the receive-pack request.
function authorizationKey(item) {
  return [item.agentId, item.owner, item.repo, item.requestHash, item.ref, item.kind, item.old, item.new].join("\0");
}

function requestKey(item) {
  return [item.agentId, item.owner, item.repo, item.requestHash].join("\0");
}

function validIdentity(item) {
  return item && typeof item === "object" &&
    typeof item.agentId === "string" && AGENT_ID.test(item.agentId) &&
    typeof item.owner === "string" && REPO_PART.test(item.owner) &&
    typeof item.repo === "string" && REPO_PART.test(item.repo) &&
    typeof item.requestHash === "string" && HASH_PATTERN.test(item.requestHash) &&
    typeof item.ref === "string" && REF.test(item.ref) &&
    typeof item.kind === "string" && KINDS.has(item.kind) &&
    typeof item.old === "string" && OID_PATTERN.test(item.old) &&
    typeof item.new === "string" && OID_PATTERN.test(item.new) &&
    typeof item.actionClass === "string" && CLASSES.has(item.actionClass) &&
    typeof item.site === "string" && item.site.length > 0 && item.site.length <= 300 &&
    typeof item.controlName === "string" && item.controlName.length > 0 && item.controlName.length <= 120;
}

function pendingView(item) {
  return {
    id: item.id, site: item.site, actionClass: item.actionClass, controlName: item.controlName,
    ref: item.ref, kind: item.kind, owner: item.owner, repo: item.repo,
    requestHash: item.requestHash, expiresAt: new Date(item.expiresAt).toISOString(),
  };
}

function grantView(item) {
  return { id: item.id, expiresAt: new Date(item.expiresAt).toISOString() };
}

export function createRegistry({ ttlMs = POLICY_TTL_MS, now = Date.now, maxPerAgent = MAX_TUNNELS_PER_AGENT, maxTotal = MAX_TUNNELS, onRemove = null,
  pendingTtlMs = PENDING_TTL_MS, grantTtlMs = GRANT_TTL_MS } = {}) {
  const agents = new Map();
  const hashToAgent = new Map();
  const pending = new Map();
  const pendingByKey = new Map();
  const grants = new Map();
  const grantByKey = new Map();
  let tunnels = 0;
  const removed = (agentId) => { try { onRemove?.(agentId); } catch { /* the policy still fails closed */ } };

  function destroyTunnels(entry) {
    for (const socket of entry.tunnels) {
      tunnels -= 1;
      try { socket.destroy(); } catch { /* already closed */ }
    }
    entry.tunnels.clear();
  }

  function removeHashes(entry) {
    for (const hash of entry.canaryHashes) {
      if (hashToAgent.get(hash) === entry.agentId) hashToAgent.delete(hash);
    }
    entry.canaryHashes = [];
  }

  function installHashes(agentId, hashes) {
    for (const hash of hashes) hashToAgent.set(hash, agentId);
  }

  function dropPending(id) {
    const item = pending.get(id);
    if (!item) return;
    const key = authorizationKey(item);
    pending.delete(id);
    if (pendingByKey.get(key) === id) pendingByKey.delete(key);
  }

  function dropGrant(id) {
    const item = grants.get(id);
    if (!item) return;
    const key = authorizationKey(item);
    grants.delete(id);
    if (grantByKey.get(key) === id) grantByKey.delete(key);
  }

  // Grants and pending records belong to an agent's live policy. A policy expiry, a trip, a
  // removal or a restart makes every outstanding approval unusable.
  function clearAgentRecords(agentId) {
    for (const item of [...pending.values()]) if (item.agentId === agentId) dropPending(item.id);
    for (const item of [...grants.values()]) if (item.agentId === agentId) dropGrant(item.id);
  }

  function pruneRecords() {
    for (const agentId of [...agents.keys()]) prune(agentId);
    const at = now();
    for (const item of [...pending.values()]) if (item.expiresAt <= at) dropPending(item.id);
    for (const item of [...grants.values()]) if (item.expiresAt <= at) dropGrant(item.id);
  }

  function queuedFor(agentId) {
    let count = 0;
    for (const item of pending.values()) if (item.queued && item.agentId === agentId) count += 1;
    return count;
  }

  function queuedTotal() {
    let count = 0;
    for (const item of pending.values()) if (item.queued) count += 1;
    return count;
  }

  function unusedGrantsFor(agentId) {
    let count = 0;
    for (const item of grants.values()) if (!item.consumedAt && item.agentId === agentId) count += 1;
    return count;
  }

  function unusedGrantsTotal() {
    let count = 0;
    for (const item of grants.values()) if (!item.consumedAt) count += 1;
    return count;
  }

  function prune(agentId) {
    const entry = agents.get(agentId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      destroyTunnels(entry);
      removeHashes(entry);
      agents.delete(agentId);
      clearAgentRecords(agentId);
      removed(agentId);
      return null;
    }
    return entry;
  }

  return {
    setPolicy(agentId, domains, blocked, options = {}) {
      const nextDomains = canonicalDomains(domains);
      const nextHashes = canonicalHashes(options.canaryHashes ?? []);
      const existing = prune(agentId);
      if (!existing) {
        const created = { agentId, domains: nextDomains, anyPublic: options.anyPublic === true, blocked, canaryHashes: nextHashes, tripped: Boolean(options.trip),
          expiresAt: now() + ttlMs, tunnels: new Set() };
        agents.set(agentId, created);
        installHashes(agentId, nextHashes);
        if (blocked) { clearAgentRecords(agentId); removed(agentId); }
        return { changed: true, tripped: created.tripped };
      }
      const changed = existing.blocked !== blocked || existing.anyPublic !== (options.anyPublic === true) ||
        existing.domains.length !== nextDomains.length ||
        existing.domains.some((domain, index) => domain !== nextDomains[index]);
      const hashesChanged = existing.canaryHashes.length !== nextHashes.length ||
        existing.canaryHashes.some((hash, index) => hash !== nextHashes[index]);
      if (changed || options.trip) destroyTunnels(existing);
      // A changed allowlist or a trip makes earlier push authorizations unusable.
      if (changed || options.trip) clearAgentRecords(agentId);
      if (blocked) { clearAgentRecords(agentId); removed(agentId); }
      if (hashesChanged) {
        removeHashes(existing);
        installHashes(agentId, nextHashes);
        existing.canaryHashes = nextHashes;
      }
      existing.domains = nextDomains;
      existing.anyPublic = options.anyPublic === true;
      existing.blocked = blocked;
      if (options.clearTrip) existing.tripped = false;
      if (options.trip) existing.tripped = true;
      existing.expiresAt = now() + ttlMs;
      return { changed, tripped: existing.tripped };
    },
    trip(agentId) {
      let entry = prune(agentId);
      if (!entry) {
        entry = { agentId, domains: [], blocked: true, canaryHashes: [], tripped: true, expiresAt: now() + ttlMs, tunnels: new Set() };
        agents.set(agentId, entry);
        clearAgentRecords(agentId);
        return;
      }
      entry.tripped = true;
      entry.blocked = true;
      destroyTunnels(entry);
      clearAgentRecords(agentId);
      removed(agentId);
    },
    tripByCanary(hash) {
      if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) return null;
      const agentId = hashToAgent.get(hash);
      return agentId && prune(agentId) ? agentId : null;
    },
    clearTrip(agentId) {
      const entry = agents.get(agentId);
      if (entry) entry.tripped = false;
    },
    get(agentId) {
      const entry = prune(agentId);
      return entry ? { domains: [...entry.domains], anyPublic: entry.anyPublic === true, blocked: entry.blocked, tripped: entry.tripped,
        canaryHashes: [...entry.canaryHashes], expiresAt: entry.expiresAt } : null;
    },
    allows(agentId, host) {
      const entry = prune(agentId);
      if (!entry || entry.blocked || entry.tripped) return false;
      // ADR-036. Any public host: callers still resolve and refuse internal, LAN and metadata addresses.
      if (entry.anyPublic) return true;
      return entry.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    },
    addTunnel(agentId, socket) {
      const entry = prune(agentId);
      if (!entry || entry.blocked || entry.tripped) return false;
      if (entry.tunnels.size >= maxPerAgent || tunnels >= maxTotal) return false;
      entry.tunnels.add(socket);
      tunnels += 1;
      return true;
    },
    removeTunnel(agentId, socket) {
      const entry = agents.get(agentId);
      if (entry && entry.tunnels.delete(socket)) tunnels -= 1;
    },
    // TASK-073c. One pending per blocked ref, grouped by requestHash. Duplicate requests reuse
    // their live IDs without extending a TTL; a request that would exceed a cap inserts nothing.
    createPending(input) {
      pruneRecords();
      const agentId = typeof input?.agentId === "string" ? input.agentId.toLowerCase() : "";
      const owner = typeof input?.owner === "string" ? input.owner.toLowerCase() : "";
      const repo = typeof input?.repo === "string" ? input.repo.toLowerCase() : "";
      const requestHash = input?.requestHash;
      const blocked = Array.isArray(input?.blocked) ? input.blocked : [];
      const commands = Array.isArray(input?.commands) ? input.commands : [];
      if (!AGENT_ID.test(agentId) || !REPO_PART.test(owner) || !REPO_PART.test(repo) || !HASH_PATTERN.test(requestHash) ||
          !blocked.length || blocked.length > 64) return { ok: false, error: "invalid_pending" };
      const refs = new Set();
      const byRef = new Map(commands.map((command) => [command.ref, command]));
      const queue = [];
      for (const item of blocked) {
        if (!item || typeof item.ref !== "string" || !REF.test(item.ref) || !KINDS.has(item.kind) || !CLASSES.has(item.class)) {
          return { ok: false, error: "invalid_pending" };
        }
        if (refs.has(item.ref)) return { ok: false, error: "duplicate_ref" };
        refs.add(item.ref);
        const command = byRef.get(item.ref);
        if (!command) return { ok: false, error: "invalid_pending" };
        const ownerText = `${owner}/${repo}`;
        const noun = item.ref.startsWith("refs/tags/") ? "tag" : "branch";
        const controlName = (item.kind === "default_branch" ? `push to ${item.name} on ${ownerText}`
          : item.kind === "tag_update" ? `move tag ${item.name} on ${ownerText}`
            : `delete ${noun} ${item.name} on ${ownerText}`)
          .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
        const identity = { agentId, owner, repo, requestHash, ref: item.ref, kind: item.kind,
          old: command.old, new: command.new, actionClass: item.class, site: `github.com/${ownerText}`, controlName };
        if (!validIdentity(identity)) return { ok: false, error: "invalid_pending" };
        queue.push(identity);
      }
      const at = now();
      const existing = queue.map((item) => {
        const found = pending.get(pendingByKey.get(authorizationKey(item)));
        if (!found) return null;
        if (found.expiresAt <= at) { dropPending(found.id); return null; }
        if (found.queued) return found;
        // An already-granted ref stays known while its unused grant is live, so a multi-ref retry
        // does not create a second card for it. A consumed or revoked grant needs a new approval.
        const grant = found.grantId ? grants.get(found.grantId) : null;
        if (grant && !grant.consumedAt && grant.expiresAt > at) return found;
        dropPending(found.id);
        return null;
      });
      const missing = existing.filter((item) => item === null).length;
      if (queuedFor(agentId) + missing > MAX_PENDING_PER_AGENT || queuedTotal() + missing > MAX_PENDING) {
        return { ok: false, error: "pending_limit" };
      }
      const pendingResult = queue.map((item, index) => {
        if (existing[index]) return existing[index];
        const id = randomUUID();
        const record = { ...item, id, createdAt: at, expiresAt: at + pendingTtlMs, queued: true, grantId: null };
        pending.set(id, record);
        pendingByKey.set(authorizationKey(record), id);
        return record;
      });
      return { ok: true, pending: pendingResult.map(pendingView) };
    },
    listPending(agentId) {
      pruneRecords();
      const id = typeof agentId === "string" ? agentId.toLowerCase() : "";
      if (!AGENT_ID.test(id)) return [];
      return [...pending.values()]
        .filter((item) => item.queued && item.agentId === id)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map(pendingView);
    },
    grantPending(agentId, pendingId) {
      pruneRecords();
      const id = typeof agentId === "string" ? agentId.toLowerCase() : "";
      const item = typeof pendingId === "string" ? pending.get(pendingId) : null;
      if (!AGENT_ID.test(id) || !item || item.agentId !== id) return { ok: false, error: "not_found" };
      if (!item.queued) {
        const grant = item.grantId ? grants.get(item.grantId) : null;
        if (grant && !grant.consumedAt && grant.expiresAt > now()) return { ok: true, grant: grantView(grant) };
        if (grant && grant.consumedAt) return { ok: false, error: "already_consumed" };
        if (grant || item.grantId) return { ok: false, error: "expired" };
        return { ok: false, error: "not_found" };
      }
      if (unusedGrantsFor(id) + 1 > MAX_GRANTS_PER_AGENT || unusedGrantsTotal() + 1 > MAX_GRANTS) {
        return { ok: false, error: "grant_limit" };
      }
      const at = now();
      const grant = {
        id: randomUUID(), agentId: item.agentId, owner: item.owner, repo: item.repo,
        requestHash: item.requestHash, ref: item.ref, kind: item.kind, old: item.old, new: item.new,
        site: item.site, actionClass: item.actionClass, createdAt: at, expiresAt: at + grantTtlMs, consumedAt: null,
      };
      grants.set(grant.id, grant);
      grantByKey.set(authorizationKey(grant), grant.id);
      item.queued = false;
      item.grantId = grant.id;
      return { ok: true, grant: grantView(grant) };
    },
    // Denial or a cancel clears the whole request group: every pending ref and every unused grant
    // that belongs to the same receive-pack request.
    denyPending(agentId, pendingId) {
      pruneRecords();
      const id = typeof agentId === "string" ? agentId.toLowerCase() : "";
      const item = typeof pendingId === "string" ? pending.get(pendingId) : null;
      if (!AGENT_ID.test(id) || !item || item.agentId !== id) return false;
      const group = requestKey(item);
      let cleared = 0;
      for (const value of [...pending.values()]) {
        if (requestKey(value) === group) { dropPending(value.id); cleared += 1; }
      }
      for (const value of [...grants.values()]) {
        if (!value.consumedAt && requestKey(value) === group) { dropGrant(value.id); cleared += 1; }
      }
      return cleared > 0;
    },
    revokeGrants(agentId, site, actionClass) {
      pruneRecords();
      const id = typeof agentId === "string" ? agentId.toLowerCase() : "";
      if (!AGENT_ID.test(id) || typeof site !== "string" || site.length === 0 || site.length > 300 ||
          typeof actionClass !== "string" || !ACTION_CLASSES.has(actionClass)) return 0;
      let cleared = 0;
      for (const item of [...grants.values()]) {
        if (!item.consumedAt && item.agentId === id && item.site === site.toLowerCase() && item.actionClass === actionClass) {
          dropGrant(item.id);
          cleared += 1;
        }
      }
      return cleared;
    },
    clearAgent(agentId) {
      const id = typeof agentId === "string" ? agentId.toLowerCase() : "";
      if (!AGENT_ID.test(id)) return false;
      clearAgentRecords(id);
      return true;
    },
    // All required grants or none. Single-threaded JavaScript makes the check-and-consume atomic,
    // so two concurrent retries cannot both forward.
    consumeGrants(input) {
      pruneRecords();
      const agentId = typeof input?.agentId === "string" ? input.agentId.toLowerCase() : "";
      const owner = typeof input?.owner === "string" ? input.owner.toLowerCase() : "";
      const repo = typeof input?.repo === "string" ? input.repo.toLowerCase() : "";
      const requestHash = input?.requestHash;
      const required = Array.isArray(input?.required) ? input.required : [];
      if (!AGENT_ID.test(agentId) || !REPO_PART.test(owner) || !REPO_PART.test(repo) || !HASH_PATTERN.test(requestHash) ||
          !required.length || required.length > 64) return { ok: false, missing: [] };
      const seen = new Set();
      const matches = [];
      for (const item of required) {
        if (!item || typeof item.ref !== "string" || !REF.test(item.ref) || !KINDS.has(item.kind) ||
            typeof item.old !== "string" || !OID_PATTERN.test(item.old) || typeof item.new !== "string" || !OID_PATTERN.test(item.new)) {
          return { ok: false, missing: [] };
        }
        const identity = { agentId, owner, repo, requestHash, ref: item.ref, kind: item.kind, old: item.old, new: item.new };
        const key = authorizationKey(identity);
        if (seen.has(key)) return { ok: false, missing: [] };
        seen.add(key);
        const grant = grants.get(grantByKey.get(key));
        if (!grant || grant.consumedAt || grant.expiresAt <= now() || grant.agentId !== agentId ||
            grant.owner !== owner || grant.repo !== repo || grant.requestHash !== requestHash) {
          return { ok: false, missing: [item.ref] };
        }
        matches.push(grant);
      }
      const at = now();
      for (const grant of matches) { grant.consumedAt = at; grantByKey.delete(authorizationKey(grant)); }
      return { ok: true, consumed: matches.length };
    },

    sweep() {
      for (const agentId of [...agents.keys()]) prune(agentId);
      pruneRecords();
    },
    closeAll() {
      for (const entry of agents.values()) { destroyTunnels(entry); removed(entry.agentId); }
      hashToAgent.clear();
      agents.clear();
      pending.clear();
      pendingByKey.clear();
      grants.clear();
      grantByKey.clear();
    },
    stats() {
      return { agents: agents.size, tunnels, tripped: [...agents.values()].filter((entry) => entry.tripped).length,
        pending: queuedTotal(), grants: unusedGrantsTotal() };
    },
  };
}
