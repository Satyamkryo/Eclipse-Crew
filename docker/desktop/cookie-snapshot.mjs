// Session-cookie snapshot for one agent's Chromium profile.
//
// Chromium never writes cookies without an expiry ("session cookies") to its profile, and Playwright's
// launchPersistentContext does not keep them either (microsoft/playwright#36139). Most website logins use
// session cookies, so the worker saves them here and puts them back after launch.
//
// The file holds login secrets, exactly like Chromium's own Cookies database beside it. It stays mode 600
// inside the agent's mode-700 profile directory and never leaves the worker process.
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const SNAPSHOT_NAME = "eclipse-session-cookies.json";
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_COOKIES = 2000;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAME_SITE = new Set(["Strict", "Lax", "None"]);
const posixModes = process.platform !== "win32";

const hasControl = (value) => /[\u0000-\u001f\u007f]/.test(value);
const bounded = (value, max) => typeof value === "string" && value.length >= 1 && value.length <= max && !hasControl(value);

function normalise(cookie) {
  if (!cookie || typeof cookie !== "object") return null;
  const { name, value, domain, path, httpOnly, secure, sameSite, partitionKey } = cookie;
  if (!bounded(name, 4096) || typeof value !== "string" || value.length > 4096 || hasControl(value)) return null;
  if (!bounded(domain, 253) || !/^[.A-Za-z0-9:[\]-]+$/.test(domain)) return null;
  if (!bounded(path, 1024) || !path.startsWith("/")) return null;
  if (typeof httpOnly !== "boolean" || typeof secure !== "boolean" || !SAME_SITE.has(sameSite)) return null;
  const safe = { name, value, domain, path, httpOnly, secure, sameSite };
  if (partitionKey !== undefined) {
    if (!bounded(partitionKey, 1024)) return null;
    safe.partitionKey = partitionKey;
  }
  return safe;
}

/** Cookies with no expiry (Playwright reports `expires: -1`), reduced to the fields we save. */
export function sessionCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  const result = [];
  for (const cookie of cookies) {
    if (cookie?.expires !== -1) continue;
    const safe = normalise(cookie);
    if (safe) result.push(safe);
    if (result.length >= MAX_COOKIES) break;
  }
  return result.sort((a, b) => `${a.domain}\n${a.path}\n${a.name}`.localeCompare(`${b.domain}\n${b.path}\n${b.name}`));
}

/** Stable text for change detection and for the file body. */
export function serialize(cookies, now = Date.now()) {
  return JSON.stringify({ version: 1, savedAt: new Date(now).toISOString(), cookies });
}
export const fingerprint = (cookies) => JSON.stringify(cookies);

/** Returns the safe cookies in a parsed snapshot, or null when the snapshot is unusable (wrong shape or too old). */
export function validateSnapshot(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join() !== "cookies,savedAt,version" || value.version !== 1) return null;
  const savedAt = typeof value.savedAt === "string" ? Date.parse(value.savedAt) : NaN;
  if (!Number.isFinite(savedAt) || now - savedAt > MAX_AGE_MS || savedAt - now > 24 * 60 * 60 * 1000) return null;
  if (!Array.isArray(value.cookies) || value.cookies.length > MAX_COOKIES) return null;
  return value.cookies.map(normalise).filter(Boolean);
}

/** Atomic private write. Zero cookies removes the file, so a logout is not undone by the next start. */
export async function writeSnapshot(directory, cookies, now = Date.now()) {
  const target = `${directory}/${SNAPSHOT_NAME}`;
  if (cookies.length === 0) {
    try { await unlink(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return;
  }
  const text = serialize(cookies, now);
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error("snapshot_too_large"), { code: "snapshot_too_large" });
  const temporary = `${directory}/.eclipse-cookies.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, target); // replaces a planted symlink itself; never writes through it
  } catch (error) {
    try { await unlink(temporary); } catch { /* nothing to clean */ }
    throw error;
  }
}

/**
 * Safe cookies from the saved snapshot, or [] when there is none or it cannot be trusted
 * (symlink, wrong owner or mode, oversized, corrupt, wrong shape, expired). Never throws.
 */
export async function readSnapshot(directory, uid, now = Date.now()) {
  const target = `${directory}/${SNAPSHOT_NAME}`;
  let file;
  try {
    file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES || stat.uid !== uid || (posixModes && (stat.mode & 0o077) !== 0)) return [];
    const cookies = validateSnapshot(JSON.parse(await file.readFile("utf8")), now);
    if (cookies === null) {
      await file.close(); file = undefined;
      try { await unlink(target); } catch { /* best effort */ }
      return [];
    }
    return cookies;
  } catch { return []; }
  finally { await file?.close().catch(() => {}); }
}
