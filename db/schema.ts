import { sql } from "drizzle-orm";
import {
  boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

export const owner = pgTable(
  "owner",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    login: text("login").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    timezone: text("timezone").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("owner_id_matches_id", sql`${table.ownerId} = ${table.id}`),
    uniqueIndex("owner_singleton_idx").on(sql`(true)`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    csrfToken: text("csrf_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastActive: timestamp("last_active", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_owner_id_idx").on(table.ownerId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    soulMd: text("soul_md").notNull(),
    status: text("status").notNull().default("paused"),
    dailyBudgetCents: integer("daily_budget_cents").notNull(),
    monthlyBudgetCents: integer("monthly_budget_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agents_owner_id_idx").on(table.ownerId),
    check("agents_status_check", sql`${table.status} in ('active', 'paused')`),
    check("agents_daily_budget_check", sql`${table.dailyBudgetCents} between 1 and 100000000`),
    check("agents_monthly_budget_check", sql`${table.monthlyBudgetCents} between 1 and 100000000`),
  ],
);

export const agentPolicies = pgTable(
  "agent_policies",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").notNull(),
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
    actions: text("actions").array().notNull().default(sql`'{}'::text[]`),
    memoryScopes: text("memory_scopes").array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_policies_owner_id_idx").on(table.ownerId),
    check("agent_policies_tools_check", sql`cardinality(${table.tools}) <= 64`),
    check("agent_policies_domains_check", sql`cardinality(${table.domains}) <= 64`),
    check("agent_policies_actions_check", sql`cardinality(${table.actions}) <= 64`),
    check("agent_policies_memory_scopes_check", sql`cardinality(${table.memoryScopes}) <= 3`),
  ],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chat_sessions_owner_id_idx").on(table.ownerId),
    uniqueIndex("chat_sessions_owner_agent_idx").on(table.ownerId, table.agentId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    cardType: text("card_type").notNull(),
    content: jsonb("content").notNull(),
    sourceTag: text("source_tag").notNull(),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_owner_id_idx").on(table.ownerId),
    index("messages_session_created_idx").on(table.sessionId, table.createdAt, table.id),
    index("messages_run_id_idx").on(table.runId),
    check("messages_role_check", sql`${table.role} in ('user', 'agent', 'system')`),
    check("messages_card_type_check", sql`${table.cardType} in ('message', 'clarification', 'tool_connection', 'routine')`),
    check("messages_source_tag_check", sql`${table.sourceTag} in ('user', 'agent', 'tool', 'system')`),
  ],
);

export const providers = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    kind: text("kind").notNull(),
    baseUrl: text("base_url"),
    encryptedKey: text("encrypted_key"),
    keyHint: text("key_hint"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("providers_owner_id_idx").on(table.ownerId),
    check("providers_kind_check", sql`${table.kind} in ('meta', 'openai-compatible')`),
  ],
);

export const modelRoles = pgTable(
  "model_roles",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    role: text("role").notNull(),
    providerId: uuid("provider_id").references(() => providers.id, { onDelete: "restrict" }),
    model: text("model"),
    useMainKey: boolean("use_main_key").notNull().default(false),
    mode: text("mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_roles_owner_id_idx").on(table.ownerId),
    index("model_roles_provider_id_idx").on(table.providerId),
    uniqueIndex("model_roles_owner_role_idx").on(table.ownerId, table.role),
    check("model_roles_role_check", sql`${table.role} in ('main', 'sam')`),
    check("model_roles_mode_check", sql`${table.mode} in ('active', 'off', 'meta')`),
    check(
      "model_roles_main_shape_check",
      sql`${table.role} <> 'main' or (${table.mode} = 'active' and ${table.providerId} is not null and ${table.model} is not null and ${table.useMainKey} = false)`,
    ),
    check(
      "model_roles_sam_shape_check",
      sql`${table.role} <> 'sam' or ((${table.mode} = 'off' and ${table.providerId} is null and ${table.model} is null and ${table.useMainKey} = false) or (${table.mode} = 'meta' and ${table.providerId} is not null and ${table.model} is not null))`,
    ),
  ],
);
