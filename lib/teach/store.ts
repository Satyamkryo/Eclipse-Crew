import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { getDatabase } from "../../db/client";
import { teachRecordings } from "../../db/schema";
import { artifactsRoot, sha256 } from "../artifacts/blob-store";
import { RequestError } from "../auth/request";
import { teachArtifact, teachHash, teachManifest } from "./schema";

export type TeachDatabase = Awaited<ReturnType<typeof getDatabase>>;
export async function ownedCapture(database: Pick<TeachDatabase, "select">, ownerId: string, captureId: string) {
  const row = (await database.select().from(teachRecordings).where(and(eq(teachRecordings.ownerId, ownerId), eq(teachRecordings.id, captureId))).limit(1))[0];
  if (!row) throw new RequestError(404, "capture_not_found");
  return row;
}
export async function listOwnedCaptures(database: Pick<TeachDatabase, "select">, ownerId: string, agentId: string) {
  return database.select({ id: teachRecordings.id, state: teachRecordings.state, activeMs: teachRecordings.activeMs,
    eventCount: teachRecordings.eventCount, narration: teachRecordings.narration,
    narrationStatus: teachRecordings.narrationStatus, createdAt: teachRecordings.createdAt }).from(teachRecordings)
    .where(and(eq(teachRecordings.ownerId, ownerId), eq(teachRecordings.agentId, agentId), eq(teachRecordings.state, "complete")))
    .orderBy(desc(teachRecordings.createdAt)).limit(20);
}
function locate(ownerId: string, captureId: string) {
  return path.join(artifactsRoot(), "teach", z.string().uuid().parse(ownerId), z.string().uuid().parse(captureId));
}
async function privatePath(ownerId: string, captureId: string, create: boolean) {
  const directory = locate(ownerId, captureId); const root = artifactsRoot();
  if (await realpath(/* turbopackIgnore: true */ root) !== root) throw Error("unsafe_artifact_root");
  let current = root;
  for (const part of ["teach", ownerId, captureId]) {
    current = path.join(/* turbopackIgnore: true */ current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await realpath(/* turbopackIgnore: true */ current) !== current) throw Error("unsafe_capture_path");
  }
  return directory;
}
export function validateArtifact(bytes: Buffer, descriptor: z.infer<typeof teachArtifact>) {
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.hash) throw Error("invalid_capture_hash");
  if (descriptor.mime === "image/png" && (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(16) > 1024 || bytes.readUInt32BE(20) > 768)) throw Error("invalid_capture_image");
  if (descriptor.mime === "video/webm" && bytes.subarray(0, 4).toString("hex") !== "1a45dfa3") throw Error("invalid_capture_video");
  if (descriptor.mime === "audio/wav" && (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")) throw Error("invalid_capture_audio");
}
export async function putCaptureArtifact(ownerId: string, captureId: string, bytes: Buffer, descriptor: z.infer<typeof teachArtifact>) {
  validateArtifact(bytes, teachArtifact.parse(descriptor));
  const directory = await privatePath(ownerId, captureId, true);
  const blobs = path.join(directory, "blobs"); const shard = path.join(blobs, descriptor.hash.slice(0, 2));
  for (const parent of [blobs, shard]) {
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await realpath(/* turbopackIgnore: true */ parent) !== parent) throw Error("unsafe_capture_path");
  }
  let handle;
  try { handle = await open(path.join(shard, descriptor.hash), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await getCaptureArtifact(ownerId, captureId, descriptor.hash))) throw error;
    return descriptor.hash;
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return descriptor.hash;
}
export async function getCaptureArtifact(ownerId: string, captureId: string, hash: string): Promise<Buffer | null> {
  teachHash.parse(hash);
  try {
    const directory = await privatePath(ownerId, captureId, false);
    const shard = path.join(directory, "blobs", hash.slice(0, 2));
    for (const name of [path.join(directory, "blobs"), shard]) {
      const stat = await lstat(name); if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ name) !== name) return null;
    }
    const file = await open(path.join(shard, hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 5 * 1024 * 1024) return null;
      const bytes = await file.readFile(); return sha256(bytes) === hash ? bytes : null;
    } finally { await file.close(); }
  } catch (error) { if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}
export async function discardCaptureArtifacts(ownerId: string, captureId: string) {
  try {
    const directory = await privatePath(ownerId, captureId, false);
    // UUIDs and every ancestor have been checked, and this is a dedicated capture
    // namespace. Never remove shared receipt/checkpoint content-addressed blobs.
    await rm(directory, { recursive: true, force: false });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function parseStoredManifest(value: unknown) {
  const parsed = z.object({ capture: teachManifest, artifacts: z.array(teachArtifact).max(1000) }).strict().safeParse(value);
  if (!parsed.success) throw new RequestError(409, "capture_not_complete");
  return parsed.data;
}
