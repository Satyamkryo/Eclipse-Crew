import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, owner, teachRecordings } from "../../db/schema";
import { RequestError } from "../auth/request";
import type { OwnerSession } from "../auth/session";
import { appendAgentCard } from "../chat/data";
import { desktopTeach } from "../desktop/client";
import { createModelSettingsStore } from "../models/data";
import { narrationSegment, teachArtifact, teachCaptureList, teachControl, teachManifest, type NarrationSegment, type TeachResult } from "./schema";
import { discardCaptureArtifacts, getCaptureArtifact, listOwnedCaptures, ownedCapture, parseStoredManifest, putCaptureArtifact, type TeachDatabase } from "./store";
import { NarrationError, transcribeNarration, validateWave } from "./transcribe";

type CaptureRow = typeof teachRecordings.$inferSelect;
type Control = z.infer<typeof teachControl>;
const ACTIVE = ["recording", "paused", "finalizing"];
const codeOf = (error: unknown) => (error as { code?: string })?.code;
export async function narrationAllowed(database: TeachDatabase, ownerId: string) {
  const main = (await createModelSettingsStore(database).load(ownerId)).main;
  return main?.provider?.kind === "meta" && !!main.provider.encryptedKey;
}
export async function listCaptures(database: TeachDatabase, ownerId: string, agentId: string) {
  const rows = await listOwnedCaptures(database, ownerId, agentId);
  return teachCaptureList.parse(rows.map((row) => ({ captureId: row.id, state: row.state, activeMs: row.activeMs,
    eventCount: row.eventCount, narration: row.narration, narrationStatus: row.narrationStatus, createdAt: row.createdAt.toISOString() })));
}
export function recoverNarrationClaims(list: NarrationSegment[], now = Date.now()) {
  // Network/response work is bounded to 60s; keep a 3-minute recovery barrier.
  // Expiry makes an orphan uncertain, never eligible for another paid call.
  return list.map((item) => item.state === "in_flight" && (!item.claimedAt || now - Date.parse(item.claimedAt) > 180000)
    ? { ...item, state: "uncertain" as const } : item);
}
function segments(row: CaptureRow): NarrationSegment[] { return recoverNarrationClaims(z.array(narrationSegment).max(300).parse(row.narrationSegments)); }
export function captureView(row: CaptureRow) {
  const manifest = row.manifest ? parseStoredManifest(row.manifest) : null;
  return { captureId: row.id, state: row.state, reason: row.reason ?? undefined, activeMs: row.activeMs,
    eventCount: row.eventCount, narration: row.narration, narrationStatus: row.narrationStatus,
    ...(manifest ? { manifest: manifest.capture, artifacts: manifest.artifacts } : {}),
    narrationSegments: segments(row),
  };
}
function validateComplete(result: TeachResult) {
  const manifest = teachManifest.parse(result.manifest);
  const artifacts = z.array(teachArtifact).min(1).max(1000).parse(result.artifacts);
  const entries = new Map(artifacts.map((item) => [item.hash, item]));
  if (manifest.captureId !== result.captureId || entries.size !== artifacts.length || artifacts.reduce((sum, item) => sum + item.bytes, 0) > 128 * 1024 * 1024 ||
      entries.get(manifest.videoHash)?.mime !== "video/webm" || manifest.durationMs !== result.activeMs || manifest.events.length !== result.eventCount) throw Error("invalid_capture_manifest");
  let time = -1;
  for (const [index, event] of manifest.events.entries()) {
    if (event.sequence !== index || event.offsetMs < time || event.offsetMs > manifest.durationMs ||
      entries.get(event.beforeHash)?.mime !== "image/png" || entries.get(event.afterHash)?.mime !== "image/png") throw Error("invalid_capture_manifest");
    time = event.offsetMs;
  }
  let audioEnd = 0;
  for (const [index, audio] of manifest.audio.entries()) {
    if (audio.sequence !== index || audio.offsetMs < audioEnd || audio.offsetMs + audio.durationMs > manifest.durationMs || entries.get(audio.hash)?.mime !== "audio/wav") throw Error("invalid_capture_manifest");
    audioEnd = audio.offsetMs + audio.durationMs;
  }
  return { capture: manifest, artifacts };
}
type Desktop = typeof desktopTeach;
export async function controlCapture(database: TeachDatabase, session: OwnerSession, agentId: string, input: Control, desktop: Desktop = desktopTeach) {
  if (input.action === "start") {
    const allowed = await narrationAllowed(database, session.ownerId);
    if (input.narration && !allowed) throw new RequestError(409, "narration_provider_unavailable");
    const captureId = randomUUID(); let started = false;
    try {
      const row = await database.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.ownerId}), hashtext(${agentId}))`);
        const agent = (await tx.select({ id: agents.id, status: agents.status, timezone: owner.timezone }).from(agents)
          .innerJoin(owner, eq(owner.id, agents.ownerId)).where(and(eq(agents.ownerId, session.ownerId), eq(agents.id, agentId))).limit(1))[0];
        if (!agent) throw new RequestError(404, "agent_not_found");
        if (agent.status !== "active") throw new RequestError(409, "agent_paused");
        const result = await desktop(agentId, session.ownerId, session.sessionRef, { ...input, captureId, timezone: agent.timezone }); started = true;
        if (result.captureId !== captureId || !["recording", "paused"].includes(result.state)) throw new RequestError(409, "capture_start_failed");
        await tx.update(teachRecordings).set({ state: "aborted", reason: "lease_lost", updatedAt: new Date() })
          .where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.agentId, agentId), inArray(teachRecordings.state, ACTIVE)));
        const rows = await tx.insert(teachRecordings).values({ id: captureId, ownerId: session.ownerId, agentId,
          generation: input.generation, state: result.state, reason: result.reason ?? null, timezone: agent.timezone,
          narration: !!input.narration, narrationStatus: input.narration ? "pending" : "off", activeMs: result.activeMs, eventCount: result.eventCount }).returning();
        return rows[0];
      });
      return { ...captureView(row), narrationAllowed: allowed };
    } catch (error) {
      if (started) await desktop(agentId, session.ownerId, session.sessionRef, { ...input, captureId, action: "discard" }).catch(() => undefined);
      throw error;
    }
  }
  const id = input.captureId!;
  const preliminary = await ownedCapture(database, session.ownerId, id);
  if (preliminary.agentId !== agentId || preliminary.generation !== input.generation) throw new RequestError(409, "stale_capture");
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.ownerId}), hashtext(${agentId}))`);
    const row = await ownedCapture(tx, session.ownerId, id);
    if (input.action === "status" && ["discarded", "failed", "aborted"].includes(row.state)) return captureView(row);
    if (input.action === "stop" && row.state === "complete") return captureView(row);
    if (input.action === "discard" && segments(row).some((item) => item.state === "in_flight")) throw new RequestError(409, "narration_in_progress");
    let result: TeachResult;
    try { result = await desktop(agentId, session.ownerId, session.sessionRef, { ...input, captureId: id }); }
    catch (error) {
      if (ACTIVE.includes(row.state) && ["not_in_takeover", "viewer_not_active", "stale_generation", "session_not_running"].includes(codeOf(error) ?? "")) {
        const aborted = (await tx.update(teachRecordings).set({ state: "aborted", reason: "lease_lost", updatedAt: new Date() })
          .where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.id, id))).returning())[0];
        return captureView(aborted);
      }
      // Completed artifacts remain owner-readable after their live worker has
      // ended; discard never depends on creating a new takeover lease.
      if (input.action === "discard" && !ACTIVE.includes(row.state)) result = { captureId: id, state: "discarded", activeMs: row.activeMs, eventCount: row.eventCount, narration: row.narration };
      else if (input.action === "status" && row.state === "complete") return captureView(row);
      else throw error;
    }
    if (result.captureId !== id) throw Error("invalid_capture_identity");
    let stored = row.manifest;
    if (input.action === "stop" && result.state === "complete") {
      const complete = validateComplete(result);
      try {
        for (const artifact of complete.artifacts) {
          const answer = await desktop(agentId, session.ownerId, session.sessionRef, { ...input, action: "artifact", hash: artifact.hash });
          const bytes = Buffer.from(answer.base64 ?? "", "base64");
          if (bytes.toString("base64") !== answer.base64) throw Error("invalid_capture_encoding");
          await putCaptureArtifact(session.ownerId, id, bytes, artifact);
        }
        stored = complete;
      } catch (error) {
        await discardCaptureArtifacts(session.ownerId, id).catch(() => undefined);
        await desktop(agentId, session.ownerId, session.sessionRef, { ...input, action: "discard" }).catch(() => undefined);
        throw error;
      }
    }
    if (input.action === "discard") { await discardCaptureArtifacts(session.ownerId, id); stored = null; }
    if (result.state === "complete" && !stored) {
      result = { captureId: id, state: "failed", reason: "capture_persistence_failed", activeMs: result.activeMs,
        eventCount: result.eventCount, narration: result.narration };
    }
    if (result.state === "paused" && row.state !== "paused") {
      // Drizzle transactions expose the same select/insert operations used by
      // the shared append-only chat helper; keep state and pause card atomic.
      await appendAgentCard(tx as unknown as TeachDatabase, session.ownerId, agentId, {
        card: { type: "teach_paused", captureId: id, reason: result.reason ?? "privacy_pause" }, sourceTag: "system",
      });
    }
    const updated = (await tx.update(teachRecordings).set({ state: result.state, reason: result.reason ?? null,
      activeMs: result.activeMs, eventCount: result.eventCount, manifest: stored,
      ...(input.action === "discard" ? { narrationSegments: [], narrationStatus: "off" } : {}), updatedAt: new Date(),
    }).where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.id, id))).returning())[0];
    return captureView(updated);
  });
}

export async function uploadNarration(database: TeachDatabase, session: OwnerSession, captureId: string,
  input: z.infer<typeof import("./schema").narrationUpload>, desktop: Desktop = desktopTeach) {
  const original = await ownedCapture(database, session.ownerId, captureId);
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.ownerId}), hashtext(${original.agentId}))`);
    const row = await ownedCapture(tx, session.ownerId, captureId);
    if (!row.narration || row.state !== "recording" || row.generation !== input.generation) throw new RequestError(409, "narration_not_recording");
    const current = segments(row);
    if (current.length !== input.sequence) throw new RequestError(409, "invalid_audio_sequence");
    const result = await desktop(row.agentId, session.ownerId, session.sessionRef, { ...input, action: "audio", captureId });
    if (result.captureId !== captureId || result.state !== "recording" || !result.segment || !result.artifacts) throw new RequestError(409, "invalid_audio");
    const segment = result.segment;
    if (segment.sequence !== input.sequence || segment.offsetMs !== input.offsetMs) throw new RequestError(409, "invalid_audio");
    const descriptor = result.artifacts.find((item) => item.hash === segment.hash && item.mime === "audio/wav");
    if (!descriptor) throw Error("invalid_audio_artifact");
    // WAV remains in the worker's bounded memory until Stop finalizes the
    // complete manifest. Transfer all committed artifacts at that barrier.
    current.push({ ...segment, state: "pending", source_tag: "tool", untrusted: true });
    await tx.update(teachRecordings).set({ narrationSegments: current, updatedAt: new Date() })
      .where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.id, captureId)));
    return { accepted: true, sequence: segment.sequence };
  });
}

export async function transcribeCapture(database: TeachDatabase, session: OwnerSession, captureId: string) {
  const row = await ownedCapture(database, session.ownerId, captureId);
  if (row.state !== "complete" || !row.narration) throw new RequestError(409, "capture_not_complete");
  const { capture } = parseStoredManifest(row.manifest);
  for (const audio of capture.audio) {
    const claimed = await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.ownerId}), hashtext(${row.agentId}))`);
      const fresh = await ownedCapture(tx, session.ownerId, captureId); const list = segments(fresh);
      if (fresh.state !== "complete" || !fresh.narration) throw new RequestError(409, "capture_not_complete");
      const currentManifest = parseStoredManifest(fresh.manifest).capture;
      if (currentManifest.captureId !== capture.captureId || currentManifest.videoHash !== capture.videoHash ||
        !currentManifest.audio.some((candidate) => candidate.hash === audio.hash && candidate.sequence === audio.sequence && candidate.durationMs === audio.durationMs && candidate.offsetMs === audio.offsetMs)) throw new RequestError(409, "invalid_audio_sequence");
      const item = list.find((candidate) => candidate.sequence === audio.sequence && candidate.hash === audio.hash);
      if (!item) throw new RequestError(409, "invalid_audio_sequence");
      if (item.state === "done") return false;
      if (item.state !== "pending") throw new RequestError(409, "narration_uncertain");
      item.state = "in_flight"; item.claimedAt = new Date().toISOString();
      await tx.update(teachRecordings).set({ narrationSegments: list, narrationStatus: "working", updatedAt: new Date() })
        .where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.id, captureId)));
      return true;
    });
    if (!claimed) continue;
    let turns: NarrationSegment["turns"]; let failed: string | null = null;
    try {
      const wav = await getCaptureArtifact(session.ownerId, captureId, audio.hash);
      if (!wav) throw new RequestError(409, "audio_not_found");
      if (validateWave(wav).durationMs !== audio.durationMs) throw new RequestError(409, "invalid_audio_duration");
      turns = (await transcribeNarration({ database, ownerId: session.ownerId, agentId: row.agentId, captureId,
        sequence: audio.sequence, offsetMs: audio.offsetMs, wav })).turns;
    } catch (error) { failed = error instanceof NarrationError ? error.code : "narration_uncertain"; }
    await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.ownerId}), hashtext(${row.agentId}))`);
      const fresh = await ownedCapture(tx, session.ownerId, captureId); const list = segments(fresh);
      const item = list.find((candidate) => candidate.sequence === audio.sequence);
      if (fresh.state !== "complete" || !item || item.state !== "in_flight") throw new RequestError(409, "capture_not_complete");
      const safeRetry = ["budget_paused", "price_required", "narration_provider_unavailable"].includes(failed ?? "");
      item.state = failed ? safeRetry ? "pending" : "uncertain" : "done";
      if (turns) item.turns = turns;
      await tx.update(teachRecordings).set({ narrationSegments: list, narrationStatus: failed ? safeRetry ? "error" : "uncertain" : "working", updatedAt: new Date() })
        .where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.id, captureId)));
    });
    if (failed) throw new RequestError(409, failed);
  }
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.ownerId}), hashtext(${row.agentId}))`);
    const fresh = await ownedCapture(tx, session.ownerId, captureId);
    if (fresh.state !== "complete" || !fresh.narration) throw new RequestError(409, "capture_not_complete");
    const manifest = parseStoredManifest(fresh.manifest).capture;
    const list = segments(fresh);
    if (manifest.audio.some((audio) => !list.some((item) => item.hash === audio.hash && item.sequence === audio.sequence && item.state === "done"))) throw new RequestError(409, "narration_uncertain");
    const updated = (await tx.update(teachRecordings).set({ narrationStatus: "complete", updatedAt: new Date() })
      .where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.id, captureId), eq(teachRecordings.state, "complete"))).returning())[0];
    return captureView(updated);
  });
}
