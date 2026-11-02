import { createHash } from "node:crypto";

// TASK-070. In-memory tool credentials pushed by the app over the private network. The proxy never reads a database
// or the encryption key, never logs a token, and drops an agent's entries when its policy is removed, blocked or
// tripped. Only /v1/tool-forward reads from here (and the git gateway in TASK-073).

export const MAX_ENTRIES_PER_AGENT = 4;
export const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const HEADERS = new Set(["x-api-key", "apikey"]);
const TOKEN_PATTERN = /^[\x21-\x7e]{8,4096}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const AGENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CredentialError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function validateCredentialEntries(value) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES_PER_AGENT) throw new CredentialError("invalid_credentials");
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new CredentialError("invalid_credentials");
    const keys = Object.keys(entry);
    if (keys.some((key) => !["host", "scheme", "header", "username", "token"].includes(key))) throw new CredentialError("invalid_credentials");
    if (typeof entry.host !== "string" || entry.host.length > 253 || entry.host !== entry.host.toLowerCase() ||
        !HOST_PATTERN.test(entry.host)) throw new CredentialError("invalid_credentials");
    if (!["bearer", "basic", "header"].includes(entry.scheme)) throw new CredentialError("invalid_credentials");
    if (entry.header !== undefined && entry.header !== null && !HEADERS.has(entry.header)) throw new CredentialError("invalid_credentials");
    if (entry.scheme === "header" && !entry.header) throw new CredentialError("invalid_credentials");
    if (entry.scheme !== "header" && entry.header) throw new CredentialError("invalid_credentials");
    if (entry.username !== undefined && entry.username !== null && !USERNAME_PATTERN.test(entry.username)) throw new CredentialError("invalid_credentials");
    if (entry.scheme === "basic" && !entry.username) throw new CredentialError("invalid_credentials");
    if (entry.scheme !== "basic" && entry.username) throw new CredentialError("invalid_credentials");
    if (typeof entry.token !== "string" || !TOKEN_PATTERN.test(entry.token)) throw new CredentialError("invalid_credentials");
    const key = entry.host;
    if (seen.has(key)) throw new CredentialError("invalid_credentials");
    seen.add(key);
    return Object.freeze({
      host: entry.host, scheme: entry.scheme, header: entry.header ?? null,
      username: entry.username ?? null, token: entry.token,
    });
  });
}

export function canonicalCredentials(entries) {
  return [...entries]
    .map((entry) => ({
      host: entry.host.toLowerCase(), scheme: entry.scheme, header: entry.header ?? null,
      username: entry.username ?? null, token: entry.token,
    }))
    .sort((left, right) => left.host.localeCompare(right.host) || left.scheme.localeCompare(right.scheme));
}

export function credentialsVersion(entries) {
  return createHash("sha256").update(JSON.stringify(canonicalCredentials(entries)), "utf8").digest("hex");
}

export function createCredentialStore() {
  const agents = new Map();
  return {
    set(agentId, entries) {
      const valid = validateCredentialEntries(entries);
      if (!valid.length) agents.delete(agentId);
      else agents.set(agentId, Object.freeze(canonicalCredentials(valid)));
      return valid.length ? credentialsVersion(valid) : null;
    },
    lookup(agentId, host) {
      const entries = agents.get(agentId);
      if (!entries) return null;
      const normalized = String(host).toLowerCase();
      return entries.find((entry) => entry.host === normalized) ?? null;
    },
    version(agentId) {
      const entries = agents.get(agentId);
      return entries ? credentialsVersion(entries) : null;
    },
    remove(agentId) { agents.delete(agentId); },
    clear() { agents.clear(); },
    stats() { return { agents: agents.size }; },
  };
}

export { AGENT_PATTERN };
