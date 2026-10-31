import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
