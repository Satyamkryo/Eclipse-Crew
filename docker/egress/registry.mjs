import { createHmac, timingSafeEqual } from "node:crypto";

// TASK-045: memory-only per-agent egress policy. The app pushes entries; a restart or a missed
// refresh expires them, so the browser fails closed. No tokens or domains are persisted.
// TASK-047: entries also carry canary hashes (never the canary) and a trip latch with no TTL.

export const POLICY_TTL_MS = 120_000;
export const MAX_TUNNELS_PER_AGENT = 64;
export const MAX_TUNNELS = 256;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

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

export function createRegistry({ ttlMs = POLICY_TTL_MS, now = Date.now, maxPerAgent = MAX_TUNNELS_PER_AGENT, maxTotal = MAX_TUNNELS } = {}) {
  const agents = new Map();
  const hashToAgent = new Map();
  let tunnels = 0;

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

  function prune(agentId) {
    const entry = agents.get(agentId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      destroyTunnels(entry);
      removeHashes(entry);
      agents.delete(agentId);
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
        const created = { agentId, domains: nextDomains, blocked, canaryHashes: nextHashes, tripped: Boolean(options.trip),
          expiresAt: now() + ttlMs, tunnels: new Set() };
        agents.set(agentId, created);
        installHashes(agentId, nextHashes);
        return { changed: true, tripped: created.tripped };
      }
      const changed = existing.blocked !== blocked ||
        existing.domains.length !== nextDomains.length ||
        existing.domains.some((domain, index) => domain !== nextDomains[index]);
      const hashesChanged = existing.canaryHashes.length !== nextHashes.length ||
        existing.canaryHashes.some((hash, index) => hash !== nextHashes[index]);
      if (changed || options.trip) destroyTunnels(existing);
      if (hashesChanged) {
        removeHashes(existing);
        installHashes(agentId, nextHashes);
        existing.canaryHashes = nextHashes;
      }
      existing.domains = nextDomains;
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
        return;
      }
      entry.tripped = true;
      entry.blocked = true;
      destroyTunnels(entry);
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
      return entry ? { domains: [...entry.domains], blocked: entry.blocked, tripped: entry.tripped,
        canaryHashes: [...entry.canaryHashes], expiresAt: entry.expiresAt } : null;
    },
    allows(agentId, host) {
      const entry = prune(agentId);
      if (!entry || entry.blocked || entry.tripped) return false;
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
    sweep() {
      for (const agentId of [...agents.keys()]) prune(agentId);
    },
    closeAll() {
      for (const entry of agents.values()) destroyTunnels(entry);
      hashToAgent.clear();
      agents.clear();
    },
    stats() {
      return { agents: agents.size, tunnels, tripped: [...agents.values()].filter((entry) => entry.tripped).length };
    },
  };
}
