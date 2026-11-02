// TASK-049. Pure task-scope checks. Everything here is derived from the owner's task, the owner-configured agent
// allowlist and the page the run started on. Page text, documents, history and tool output never widen the scope.

const MAX_TEXT = 2_000;
const MAX_TARGETS = 50;
const DAY_PORTS = new Set(["http:", "https:"]);
const TLDS = new Set([
  "com", "net", "org", "io", "co", "ai", "dev", "app", "in", "uk", "de", "fr", "jp", "au", "ca", "us", "eu", "edu",
  "gov", "info", "biz", "xyz", "me", "tv",
]);
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const WWW_PATTERN = /\bwww\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}\b/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const LOCALHOST_PATTERN = /\blocalhost(?::\d{1,5})?\b/gi;
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}\b/gi;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const TRAILING = /[),.;:!?'"\u2019\u201d]+$/;

export type ScopeRule = "host" | "recipient" | "page";

export interface Scope {
  hosts: string[];
  emails: string[];
}

export interface ScopeVerdict {
  ok: boolean;
  rule?: ScopeRule;
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, MAX_TEXT).replace(/[\u0000-\u001f\u007f]/g, " ")
    : "";
}

export function normalizeHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return null;
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(":");
    // A single colon is a port; several are an IPv6 literal and stay whole.
    if (colon > -1 && host.indexOf(":") === colon) host = host.slice(0, colon);
  }
  host = host.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!host || host.length > 253) return null;
  if (/[\s/@\\<>"'`*]/.test(host)) return null;
  return host;
}

function isIp(host: string): boolean {
  return IPV4.test(host) || host.includes(":");
}

export function hostFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    if (!DAY_PORTS.has(url.protocol)) return null;
    return normalizeHost(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return null;
  }
}

function pushHost(targets: string[], value: string | null) {
  if (value && !targets.includes(value)) targets.push(value);
}

// Valid hosts and email addresses named in the owner's text. Invalid URL syntax is reported so the caller can fail closed.
export function extractTargets(input: unknown): Scope {
  const text = clean(input);
  const hosts: string[] = [];
  const emails: string[] = [];
  if (!text) return { hosts, emails };

  for (const match of text.match(URL_PATTERN) ?? []) {
    if (hosts.length >= MAX_TARGETS) break;
    const host = hostFromUrl(match.replace(TRAILING, ""));
    pushHost(hosts, host ?? "invalid");
  }
  // Email domains are recipients, not destinations.
  const hostText = text.replace(EMAIL_PATTERN, " ");
  for (const match of hostText.match(WWW_PATTERN) ?? []) {
    if (hosts.length >= MAX_TARGETS) break;
    pushHost(hosts, normalizeHost(match));
  }
  for (const match of hostText.match(IPV4_PATTERN) ?? []) {
    if (hosts.length >= MAX_TARGETS) break;
    pushHost(hosts, normalizeHost(match));
  }
  for (const match of hostText.match(LOCALHOST_PATTERN) ?? []) {
    if (hosts.length >= MAX_TARGETS) break;
    pushHost(hosts, normalizeHost(match));
  }
  for (const match of hostText.match(DOMAIN_PATTERN) ?? []) {
    if (hosts.length >= MAX_TARGETS) break;
    const suffix = match.toLowerCase().split(".").pop() ?? "";
    if (TLDS.has(suffix)) pushHost(hosts, normalizeHost(match));
  }
  for (const match of text.match(EMAIL_PATTERN) ?? []) {
    if (emails.length >= MAX_TARGETS) break;
    const email = match.toLowerCase();
    if (!emails.includes(email)) emails.push(email);
  }
  return { hosts: hosts.slice(0, MAX_TARGETS), emails: emails.slice(0, MAX_TARGETS) };
}

export function deriveScope(input: {
  task: string;
  allowedHosts?: readonly string[] | null;
  startHref?: string | null;
}): Scope {
  const hosts: string[] = [];
  for (const allowed of input.allowedHosts ?? []) pushHost(hosts, normalizeHost(allowed));
  for (const host of extractTargets(input.task).hosts) pushHost(hosts, host);
  pushHost(hosts, hostFromUrl(input.startHref));
  return { hosts: hosts.slice(0, MAX_TARGETS + 64), emails: extractTargets(input.task).emails };
}

export function hostInScope(host: unknown, scope: Scope): boolean {
  const target = normalizeHost(host);
  if (!target) return false;
  for (const entry of scope.hosts) {
    const allowed = normalizeHost(entry);
    if (!allowed) continue;
    if (target === allowed) return true;
    if (!isIp(target) && !isIp(allowed) && target.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

// Rules, in order: (1) every named host must be in scope; (2) every email must be one the owner named; (3) typing on a
// page that is itself out of scope is refused unless the whole text is one in-scope URL (typing an allowed address).
export function checkTyped(input: unknown, scope: Scope, pageHref: unknown): ScopeVerdict {
  const text = clean(input);
  const targets = extractTargets(text);

  for (const host of targets.hosts) if (!hostInScope(host, scope)) return { ok: false, rule: "host" };
  for (const email of targets.emails) if (!scope.emails.includes(email)) return { ok: false, rule: "recipient" };

  const pageHost = hostFromUrl(pageHref);
  if (pageHost && !hostInScope(pageHost, scope)) {
    const trimmed = text.trim();
    if (trimmed && trimmed === trimmed.replace(TRAILING, "")) {
      try {
        const single = new URL(trimmed);
        if (DAY_PORTS.has(single.protocol) && hostInScope(single.hostname.replace(/^\[|\]$/g, ""), scope)) {
          return { ok: true };
        }
      } catch {
        // Not a single URL, so the page rule applies.
      }
    }
    return { ok: false, rule: "page" };
  }
  return { ok: true };
}
