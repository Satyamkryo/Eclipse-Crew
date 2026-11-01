import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { getDatabase } from "../../db/client";
import { modelRoles, providers } from "../../db/schema";
import { ModelSettingsError } from "./errors";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Store = Pick<Database, "select">;
type MutationStore = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

export type StoredProvider = {
  id: string;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  encryptedKey: string | null;
  keyHint: string | null;
};

export type StoredModelRole = {
  role: "main" | "sam";
  providerId: string | null;
  provider: StoredProvider | null;
  model: string | null;
  useMainKey: boolean;
  mode: "active" | "off" | "meta";
};

export type StoredModelSettings = {
  main: StoredModelRole | null;
  sam: StoredModelRole | null;
};

export type SaveMainRecord = {
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  encryptedKey?: string;
  keyHint?: string;
  clearKey?: boolean;
};

export type SaveSamRecord =
  | { mode: "off" }
  | { mode: "meta"; useMainKey: boolean; model: string; encryptedKey?: string; keyHint?: string };

export interface ModelSettingsStore {
  load(ownerId: string): Promise<StoredModelSettings>;
  saveMain(ownerId: string, input: SaveMainRecord): Promise<void>;
  saveSam(ownerId: string, input: SaveSamRecord): Promise<void>;
}

async function selectRoles(database: Store, ownerId: string) {
  return database.select({
    role: modelRoles.role,
    providerId: modelRoles.providerId,
    model: modelRoles.model,
    useMainKey: modelRoles.useMainKey,
    mode: modelRoles.mode,
    kind: providers.kind,
    baseUrl: providers.baseUrl,
    encryptedKey: providers.encryptedKey,
    keyHint: providers.keyHint,
    providerOwnerId: providers.ownerId,
  }).from(modelRoles)
    .leftJoin(providers, and(eq(providers.id, modelRoles.providerId), eq(providers.ownerId, ownerId)))
    .where(eq(modelRoles.ownerId, ownerId));
}

function toStoredRole(row: Awaited<ReturnType<typeof selectRoles>>[number]): StoredModelRole {
  const provider = row.providerId && !row.providerOwnerId ? null : row.providerId ? {
    id: row.providerId,
    kind: row.kind as StoredProvider["kind"],
    baseUrl: row.baseUrl,
    encryptedKey: row.encryptedKey,
    keyHint: row.keyHint,
  } : null;
  return {
    role: row.role as StoredModelRole["role"],
    providerId: row.providerId,
    provider,
    model: row.model,
    useMainKey: row.useMainKey,
    mode: row.mode as StoredModelRole["mode"],
  };
}

async function roleProviderId(transaction: Transaction, ownerId: string, role: "main" | "sam") {
  const rows = await transaction.select({ providerId: modelRoles.providerId }).from(modelRoles)
    .where(and(eq(modelRoles.ownerId, ownerId), eq(modelRoles.role, role))).limit(1);
  return rows[0]?.providerId ?? null;
}

async function saveRole(
  transaction: Transaction,
  ownerId: string,
  role: "main" | "sam",
  values: { providerId: string | null; model: string | null; useMainKey: boolean; mode: string },
) {
  await transaction.insert(modelRoles).values({
    id: randomUUID(),
    ownerId,
    role,
    providerId: values.providerId,
    model: values.model,
    useMainKey: values.useMainKey,
    mode: values.mode,
  }).onConflictDoUpdate({
    target: [modelRoles.ownerId, modelRoles.role],
    set: {
      providerId: values.providerId,
      model: values.model,
      useMainKey: values.useMainKey,
      mode: values.mode,
      updatedAt: new Date(),
    },
  });
}

async function lockModelSettings(transaction: Transaction) {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(691065)`);
}

async function deleteUnusedProvider(transaction: Transaction, ownerId: string, providerId: string | null) {
  if (!providerId) return;
  const remaining = await transaction.select({ id: modelRoles.id }).from(modelRoles)
    .where(and(eq(modelRoles.ownerId, ownerId), eq(modelRoles.providerId, providerId))).limit(1);
  if (!remaining[0]) {
    await transaction.delete(providers)
      .where(and(eq(providers.ownerId, ownerId), eq(providers.id, providerId)));
  }
}

export function createModelSettingsStore(database: MutationStore): ModelSettingsStore {
  return {
    async load(ownerId) {
      const rows = await selectRoles(database, ownerId);
      return {
        main: rows.find((row) => row.role === "main") ? toStoredRole(rows.find((row) => row.role === "main")!) : null,
        sam: rows.find((row) => row.role === "sam") ? toStoredRole(rows.find((row) => row.role === "sam")!) : null,
      };
    },

    async saveMain(ownerId, input) {
      await database.transaction(async (transaction) => {
        await lockModelSettings(transaction);
        const currentProviderId = await roleProviderId(transaction, ownerId, "main");
        const sam = await transaction.select({ useMainKey: modelRoles.useMainKey }).from(modelRoles)
          .where(and(eq(modelRoles.ownerId, ownerId), eq(modelRoles.role, "sam"))).limit(1);
        if (input.kind !== "meta" && sam[0]?.useMainKey) {
          throw new ModelSettingsError("sam_depends_on_main_key", 409);
        }
        const currentProvider = currentProviderId
          ? (await transaction.select({ kind: providers.kind }).from(providers)
            .where(and(eq(providers.ownerId, ownerId), eq(providers.id, currentProviderId))).limit(1))[0]
          : undefined;
        let providerId = currentProviderId;
        if (providerId) {
          const clearKey = input.encryptedKey === undefined
            && (input.clearKey || Boolean(currentProvider && currentProvider.kind !== input.kind));
          await transaction.update(providers).set({
            kind: input.kind,
            baseUrl: input.baseUrl,
            ...(clearKey ? { encryptedKey: null, keyHint: null }
              : input.encryptedKey !== undefined ? { encryptedKey: input.encryptedKey } : {}),
            ...(clearKey ? {} : input.keyHint !== undefined ? { keyHint: input.keyHint } : {}),
            updatedAt: new Date(),
          }).where(and(eq(providers.ownerId, ownerId), eq(providers.id, providerId)));
        } else {
          providerId = randomUUID();
          await transaction.insert(providers).values({
            id: providerId,
            ownerId,
            kind: input.kind,
            baseUrl: input.baseUrl,
            encryptedKey: input.encryptedKey ?? null,
            keyHint: input.keyHint ?? null,
          });
        }
        await saveRole(transaction, ownerId, "main", {
          providerId,
          model: input.model,
          useMainKey: false,
          mode: "active",
        });
      });
    },

    async saveSam(ownerId, input) {
      await database.transaction(async (transaction) => {
        await lockModelSettings(transaction);
        const previousProviderId = await roleProviderId(transaction, ownerId, "sam");
        if (input.mode === "off") {
          await saveRole(transaction, ownerId, "sam", {
            providerId: null, model: null, useMainKey: false, mode: "off",
          });
          await deleteUnusedProvider(transaction, ownerId, previousProviderId);
          return;
        }

        const mainProviderId = await roleProviderId(transaction, ownerId, "main");
        if (input.useMainKey) {
          if (!mainProviderId) throw new ModelSettingsError("main_key_required");
          const mainProvider = (await transaction.select({
            kind: providers.kind,
            encryptedKey: providers.encryptedKey,
          }).from(providers)
            .where(and(eq(providers.ownerId, ownerId), eq(providers.id, mainProviderId))).limit(1))[0];
          if (mainProvider?.kind !== "meta" || !mainProvider.encryptedKey) {
            throw new ModelSettingsError("main_key_required");
          }
          await saveRole(transaction, ownerId, "sam", {
            providerId: mainProviderId, model: input.model, useMainKey: true, mode: "meta",
          });
          if (previousProviderId !== mainProviderId) {
            await deleteUnusedProvider(transaction, ownerId, previousProviderId);
          }
          return;
        }

        let providerId = previousProviderId && previousProviderId !== mainProviderId ? previousProviderId : null;
        if (providerId) {
          await transaction.update(providers).set({
            ...(input.encryptedKey !== undefined ? { encryptedKey: input.encryptedKey } : {}),
            ...(input.keyHint !== undefined ? { keyHint: input.keyHint } : {}),
            updatedAt: new Date(),
          }).where(and(eq(providers.ownerId, ownerId), eq(providers.id, providerId)));
        } else {
          providerId = randomUUID();
          await transaction.insert(providers).values({
            id: providerId,
            ownerId,
            kind: "meta",
            baseUrl: null,
            encryptedKey: input.encryptedKey ?? null,
            keyHint: input.keyHint ?? null,
          });
        }
        await saveRole(transaction, ownerId, "sam", {
          providerId, model: input.model, useMainKey: false, mode: "meta",
        });
      });
    },
  };
}
