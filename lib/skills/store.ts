import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { getDatabase } from "../../db/client";
import { skills, teachRecordings } from "../../db/schema";
import { artifactsRoot } from "../artifacts/blob-store";
import { discardCaptureArtifacts, getCaptureArtifact } from "../teach/store";
import { referenceShotSchema, skillStatusSchema, type ReferenceShot, type SkillView } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const HASH = /^[0-9a-f]{64}$/;

export class SkillStoreError extends Error {
  constructor(public code: "skill_not_found" | "cleanup_failed" | "reference_shot_unavailable") {
    super(code);
    this.name = "SkillStoreError";
  }
}

export function serializeSkill(row: typeof skills.$inferSelect): SkillView {
  return {
    id: row.id,
    agentId: row.agentId,
    captureId: row.captureId,
    name: row.name,
    description: row.description,
    source: row.source as SkillView["source"],
    status: skillStatusSchema.parse(row.status),
    version: row.version,
    body: row.body,
    referenceShots: z.array(referenceShotSchema).parse(row.referenceShots),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function ownedSkill(database: Pick<Database, "select">, ownerId: string, skillId: string) {
  const row = (await database.select().from(skills)
    .where(and(eq(skills.ownerId, ownerId), eq(skills.id, skillId))).limit(1))[0];
  if (!row) throw new SkillStoreError("skill_not_found");
  return row;
}

export async function listApprovedSkills(database: Pick<Database, "select">, ownerId: string, agentId: string) {
  return database.select({ name: skills.name, description: skills.description, body: skills.body }).from(skills)
    .where(and(eq(skills.ownerId, ownerId), eq(skills.agentId, agentId), eq(skills.status, "approved")))
    .orderBy(asc(skills.name)).limit(20);
}

export async function approveSkill(database: Database, ownerId: string, skillId: string) {
  let skill = await ownedSkill(database, ownerId, skillId);
  if (skill.status === "approved") return serializeSkill(skill);

  let retained = z.array(referenceShotSchema).parse(skill.referenceShots);
  if (skill.status === "draft") {
    try {
      retained = await retainReferenceShots({
        root: artifactsRoot(), ownerId, skillId, version: skill.version, shots: retained,
        read: (hash) => getCaptureArtifact(ownerId, skill.captureId, hash),
      });
    } catch {
      throw new SkillStoreError("cleanup_failed");
    }
    skill = (await database.update(skills).set({ status: "cleanup_pending", referenceShots: retained, updatedAt: new Date() })
      .where(and(eq(skills.ownerId, ownerId), eq(skills.id, skillId), eq(skills.status, "draft"))).returning())[0] ?? await ownedSkill(database, ownerId, skillId);
  }
  if (retained.some((shot) => !shot.path)) throw new SkillStoreError("cleanup_failed");

  try {
    await discardCaptureArtifacts(ownerId, skill.captureId);
  } catch {
    throw new SkillStoreError("cleanup_failed");
  }
  const approved = await database.transaction(async (tx) => {
    await tx.update(teachRecordings).set({
      state: "discarded", reason: "skill_approved", manifest: null, narrationSegments: [], narrationStatus: "off", updatedAt: new Date(),
    }).where(and(eq(teachRecordings.ownerId, ownerId), eq(teachRecordings.id, skill.captureId)));
    return (await tx.update(skills).set({ status: "approved", referenceShots: retained, updatedAt: new Date() })
      .where(and(eq(skills.ownerId, ownerId), eq(skills.id, skillId), eq(skills.status, "cleanup_pending"))).returning())[0];
  });
  if (!approved) throw new SkillStoreError("cleanup_failed");
  return serializeSkill(approved);
}

export async function retainReferenceShots(options: {
  root: string;
  ownerId: string;
  skillId: string;
  version: number;
  shots: ReferenceShot[];
  read: (hash: string) => Promise<Buffer | null>;
}) {
  const ownerId = z.string().uuid().parse(options.ownerId);
  const skillId = z.string().uuid().parse(options.skillId);
  const version = z.number().int().min(1).max(10_000).parse(options.version);
  const shots = z.array(referenceShotSchema).min(1).max(32).parse(options.shots);
  if (new Set(shots.map((shot) => shot.step)).size !== shots.length) throw new Error("invalid_reference_shots");
  const directory = path.join(path.resolve(options.root), "skills", ownerId, skillId, `v${version}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const retained: Array<ReferenceShot & { path: string }> = [];
  for (const shot of shots) {
    if (!HASH.test(shot.hash)) throw new Error("invalid_reference_shots");
    const bytes = await options.read(shot.hash);
    if (!bytes || bytes.length > 8 * 1024 * 1024) throw new Error("reference_shot_unavailable");
    const name = `step-${shot.step}.png`;
    const target = path.join(directory, name);
    const temporary = path.join(directory, `.${randomBytes(12).toString("hex")}.part`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    retained.push({ ...shot, path: `skills/${ownerId}/${skillId}/v${version}/${name}` });
  }
  return retained;
}

export async function readRetainedShot(root: string, relativePath: string): Promise<Buffer | null> {
  const parsed = z.string().min(1).max(500).refine((value) => !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "." || part === "")).safeParse(relativePath);
  if (!parsed.success) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, parsed.data);
  if (!target.startsWith(`${base}${path.sep}`)) return null;
  try { return await readFile(target); } catch { return null; }
}
