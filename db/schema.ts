import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

export const owner = pgTable(
  "owner",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    login: text("login").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    timezone: text("timezone").notNull(),
    // TASK-052. Set by Stop crew before any agent is halted; cleared only by Resume crew.
    crewStoppedAt: timestamp("crew_stopped_at", { withTimezone: true }),
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
    attentionReason: text("attention_reason"),
    // TASK-051. Removes only the approval prompt. See ADR-019; every other safety layer is unchanged.
    astraMode: boolean("astra_mode").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agents_owner_id_idx").on(table.ownerId),
    check("agents_status_check", sql`${table.status} in ('active', 'paused')`),
    check("agents_daily_budget_check", sql`${table.dailyBudgetCents} between 1 and 100000000`),
    check("agents_monthly_budget_check", sql`${table.monthlyBudgetCents} between 1 and 100000000`),
    check("agents_attention_reason_check", sql`${table.attentionReason} is null or ${table.attentionReason} in ('budget_warning', 'budget_paused', 'security_stop', 'approval_pending')`),
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

// TASK-047. One canary per agent. The proxy receives only the hash; the plaintext stays encrypted.
export const agentCanaries = pgTable(
  "agent_canaries",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").notNull(),
    encryptedCanary: text("encrypted_canary").notNull(),
    canarySha256: text("canary_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    plantedAt: timestamp("planted_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_canaries_owner_id_idx").on(table.ownerId),
    uniqueIndex("agent_canaries_sha256_idx").on(table.canarySha256),
  ],
);

// TASK-047. Append-only for the app role. No agent FK, so the proof survives agent deletion; no free-text column.
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    runId: uuid("run_id"),
    sourceRef: text("source_ref").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("security_events_owner_created_idx").on(table.ownerId, table.createdAt.desc()),
    check("security_events_kind_check", sql`${table.kind} in ('canary_leak', 'scope_blocked')`),
    check("security_events_source_check", sql`${table.source} in ('typed_text', 'proxy_host', 'proxy_request', 'scope_host', 'scope_recipient', 'scope_page')`),
  ],
);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    captureId: uuid("capture_id").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    body: text("body").notNull(),
    referenceShots: jsonb("reference_shots").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("skills_owner_id_idx").on(table.ownerId),
    index("skills_agent_id_idx").on(table.agentId),
    uniqueIndex("skills_owner_agent_name_idx").on(table.ownerId, table.agentId, table.name),
    check("skills_source_check", sql`${table.source} in ('video', 'steps_screenshots')`),
    check("skills_status_check", sql`${table.status} in ('draft', 'cleanup_pending', 'approved')`),
    check("skills_version_check", sql`${table.version} > 0`),
    check("skills_name_check", sql`${table.name} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`),
  ],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    source: text("source").notNull(),
    referenceShots: jsonb("reference_shots").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_versions_owner_id_idx").on(table.ownerId),
    uniqueIndex("skill_versions_skill_version_idx").on(table.skillId, table.version),
    check("skill_versions_source_check", sql`${table.source} in ('video', 'steps_screenshots')`),
    check("skill_versions_version_check", sql`${table.version} > 0`),
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
    check("messages_card_type_check", sql`${table.cardType} in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused', 'teach_paused', 'skill_update', 'approval', 'memory_change')`),
    check("messages_source_tag_check", sql`${table.sourceTag} in ('user', 'agent', 'tool', 'system')`),
  ],
);

// TASK-038. A confirmed routine-card message becomes one owner-scoped schedule. `skill_id` gains its foreign key in
// TASK-037, when the skills table exists. Times are stored in UTC; the IANA zone is kept beside them for DST-safe editing.
export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").notNull().unique().references(() => messages.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),
    goal: text("goal").notNull(),
    steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
    schedule: text("schedule").notNull(),
    scheduleSpec: jsonb("schedule_spec").notNull(),
    timezone: text("timezone").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    budgetCents: integer("budget_cents").notNull(),
    catchUp: text("catch_up").notNull(),
    active: boolean("active").notNull().default(true),
    mode: text("mode").notNull().default("cron"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("routines_owner_id_idx").on(table.ownerId),
    index("routines_agent_id_idx").on(table.agentId),
    index("routines_owner_next_run_idx").on(table.ownerId, table.nextRunAt),
    check("routines_catch_up_check", sql`${table.catchUp} in ('skip', 'run_once', 'run_all')`),
    check("routines_mode_check", sql`${table.mode} = 'cron'`),
    check("routines_budget_check", sql`${table.budgetCents} between 1 and 100000000`),
    check("routines_schedule_check", sql`char_length(${table.schedule}) between 1 and 200 and char_length(${table.timezone}) between 1 and 100 and jsonb_typeof(${table.steps}) = 'array'`),
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
    // TASK-027: Main only. "auto" switches to `hardModel` (same provider and key) for hard steps; "fixed" never does.
    routing: text("routing").notNull().default("fixed"),
    hardModel: text("hard_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_roles_owner_id_idx").on(table.ownerId),
    index("model_roles_provider_id_idx").on(table.providerId),
    uniqueIndex("model_roles_owner_role_idx").on(table.ownerId, table.role),
    check("model_roles_role_check", sql`${table.role} in ('main', 'sam')`),
    check("model_roles_mode_check", sql`${table.mode} in ('active', 'off', 'meta')`),
    check("model_roles_routing_check", sql`${table.routing} in ('fixed', 'auto') and (${table.routing} = 'fixed' or ${table.hardModel} is not null) and (${table.role} = 'main' or (${table.routing} = 'fixed' and ${table.hardModel} is null))`),
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

// TASK-029. One row per agent run. The header is stored as the exact canonical text that was hashed. The seal columns
// are NULL until the run ends, then set once (WHERE signature IS NULL). `agent_id` has no foreign key on purpose: the
// proof must outlive the agent.
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    branchOf: uuid("branch_of"),
    headerJson: text("header_json").notNull(),
    headerHash: text("header_hash").notNull(),
    keyId: text("key_id").notNull(),
    publicKey: text("public_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("running"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    stepCount: integer("step_count"),
    headHash: text("head_hash"),
    usage: jsonb("usage"),
    signature: text("signature"),
  },
  (table) => [
    index("runs_owner_id_idx").on(table.ownerId),
    index("runs_owner_started_idx").on(table.ownerId, table.startedAt.desc()),
    check(
      "runs_sealed_check",
      sql`(${table.signature} is null and ${table.endedAt} is null and ${table.stepCount} is null and ${table.headHash} is null and ${table.usage} is null) or (${table.signature} is not null and ${table.endedAt} is not null and ${table.stepCount} is not null and ${table.headHash} is not null and ${table.usage} is not null)`,
    ),
  ],
);

// Receipts are append-only: the app role can SELECT and INSERT here, never UPDATE or DELETE.
export const steps = pgTable(
  "steps",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    runId: uuid("run_id").notNull().references(() => runs.id),
    idx: integer("idx").notNull(),
    receiptJson: text("receipt_json").notNull(),
    receiptHash: text("receipt_hash").notNull(),
    prevHash: text("prev_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("steps_owner_id_idx").on(table.ownerId),
    uniqueIndex("steps_run_idx_idx").on(table.runId, table.idx),
  ],
);

// TASK-031. Display data next to a receipt: which stored screenshots (by SHA-256, matching the signed before/after hashes)
// belong to the step, and the SAM box to outline. The box is an annotation, not part of the signed receipt. Insert-only
// for the app role.
// TASK-034. Owner-editable rates in whole micro-USD per million tokens or per thousand images. Unknown hosted models
// have no row and stop the run before spending; local endpoints resolve to zero in code.
export const teachRecordings = pgTable(
  "teach_recordings",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    generation: uuid("generation").notNull(),
    state: text("state").notNull(),
    reason: text("reason"),
    timezone: text("timezone").notNull(),
    narration: boolean("narration").notNull().default(false),
    narrationStatus: text("narration_status").notNull().default("off"),
    narrationSegments: jsonb("narration_segments").notNull().default(sql`'[]'::jsonb`),
    manifest: jsonb("manifest"),
    activeMs: integer("active_ms").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("teach_recordings_owner_id_idx").on(table.ownerId),
    index("teach_recordings_agent_id_idx").on(table.agentId),
    uniqueIndex("teach_recordings_active_agent_idx").on(table.ownerId, table.agentId)
      .where(sql`${table.state} in ('recording', 'paused', 'finalizing')`),
    check("teach_recordings_state_check", sql`${table.state} in ('recording', 'paused', 'finalizing', 'complete', 'aborted', 'failed', 'discarded')`),
    check("teach_recordings_narration_status_check", sql`${table.narrationStatus} in ('off', 'pending', 'working', 'complete', 'error', 'uncertain')`),
    check("teach_recordings_bounds_check", sql`${table.activeMs} between 0 and 120000 and ${table.eventCount} between 0 and 300`),
  ],
);

export const modelPrices = pgTable(
  "model_prices",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    providerId: uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    inputMicroUsdPerMillion: bigint("input_micro_usd_per_million", { mode: "number" }).notNull().default(0),
    cachedMicroUsdPerMillion: bigint("cached_micro_usd_per_million", { mode: "number" }).notNull().default(0),
    outputMicroUsdPerMillion: bigint("output_micro_usd_per_million", { mode: "number" }).notNull().default(0),
    imageMicroUsdPerThousand: bigint("image_micro_usd_per_thousand", { mode: "number" }).notNull().default(0),
    audioMicroUsdPerHour: bigint("audio_micro_usd_per_hour", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_prices_owner_id_idx").on(table.ownerId),
    index("model_prices_provider_id_idx").on(table.providerId),
    uniqueIndex("model_prices_owner_provider_model_idx").on(table.ownerId, table.providerId, table.model),
    check("model_prices_model_check", sql`${table.model} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'`),
    check("model_prices_rates_check", sql`${table.inputMicroUsdPerMillion} between 0 and 1000000000 and ${table.cachedMicroUsdPerMillion} between 0 and 1000000000 and ${table.outputMicroUsdPerMillion} between 0 and 1000000000 and ${table.imageMicroUsdPerThousand} between 0 and 1000000000 and ${table.audioMicroUsdPerHour} between 0 and 1000000000`),
  ],
);

// TASK-034. Append-only, one row per attempted model call. Provider and model are snapshots so deleting a provider
// never rewrites spend history. `cost:<run_id>:<call_index>` makes a retried call idempotent.
export const costEntries = pgTable(
  "cost_entries",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    captureId: uuid("capture_id").references(() => teachRecordings.id),
    audioDurationMs: integer("audio_duration_ms").notNull().default(0),
    agentId: uuid("agent_id").notNull(),
    providerId: uuid("provider_id").notNull(),
    callIndex: integer("call_index").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    tokensCached: integer("tokens_cached").notNull(),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull(),
    outcome: text("outcome").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("cost_entries_owner_id_idx").on(table.ownerId),
    index("cost_entries_run_id_idx").on(table.runId),
    uniqueIndex("cost_entries_run_call_idx").on(table.runId, table.callIndex),
    uniqueIndex("cost_entries_capture_call_idx").on(table.captureId, table.callIndex),
    uniqueIndex("cost_entries_idempotency_key_idx").on(table.idempotencyKey),
    check("cost_entries_call_index_check", sql`${table.callIndex} > 0`),
    check("cost_entries_tokens_check", sql`${table.tokensIn} >= 0 and ${table.tokensOut} >= 0 and ${table.tokensCached} >= 0 and ${table.tokensCached} <= ${table.tokensIn}`),
    check("cost_entries_cost_check", sql`${table.costMicroUsd} >= 0`),
    check("cost_entries_outcome_check", sql`${table.outcome} ~ '^[a-z_]{1,64}$'`),
    check("cost_entries_source_check", sql`(${table.runId} is not null)::integer + (${table.captureId} is not null)::integer = 1`),
    check("cost_entries_audio_duration_check", sql`${table.audioDurationMs} between 0 and 120000`),
    check("cost_entries_idempotency_check", sql`(${table.runId} is not null and ${table.idempotencyKey} = 'cost:' || ${table.runId}::text || ':' || ${table.callIndex}::text) or (${table.captureId} is not null and (${table.idempotencyKey} = 'teach:' || ${table.captureId}::text || ':asr:' || (${table.callIndex} - 1)::text or ${table.idempotencyKey} = 'teach:' || ${table.captureId}::text || ':skill:' || ${table.callIndex}::text))`),
  ],
);

export const stepEvidence = pgTable(
  "step_evidence",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    runId: uuid("run_id").notNull().references(() => runs.id),
    idx: integer("idx").notNull(),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    width: integer("width"),
    height: integer("height"),
    samBox: jsonb("sam_box"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("step_evidence_owner_id_idx").on(table.ownerId),
    uniqueIndex("step_evidence_run_idx_idx").on(table.runId, table.idx),
  ],
);

// TASK-032. One row per step boundary of a run (idx 0 is the state before the first step; idx N matches receipt N). The state
// and the file manifest live in the artifacts store, addressed by SHA-256; this row only points at them. `partial` means the
// capture was incomplete (reason says why) and rewind must refuse it. Insert-only for the app role.
export const checkpoints = pgTable(
  "checkpoints",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    runId: uuid("run_id").notNull().references(() => runs.id),
    idx: integer("idx").notNull(),
    stateHash: text("state_hash").notNull(),
    manifestHash: text("manifest_hash"),
    fileCount: integer("file_count").notNull().default(0),
    restorableCount: integer("restorable_count").notNull().default(0),
    status: text("status").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("checkpoints_owner_id_idx").on(table.ownerId),
    uniqueIndex("checkpoints_run_idx_idx").on(table.runId, table.idx),
    check("checkpoints_status_check", sql`${table.status} in ('complete', 'partial')`),
  ],
);

// TASK-041. A verified run compiled into a replay script: the steps (role + exact name per click, structural postconditions,
// no typed text, no coordinates) validated by lib/replay/script.ts. One script per source run, so compiling twice returns the
// same row. The source run is a plain reference: deleting a script never touches the proof, and the app role cannot UPDATE here.
export const replayScripts = pgTable(
  "replay_scripts",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    sourceRunId: uuid("source_run_id").notNull().references(() => runs.id),
    name: text("name").notNull(),
    steps: jsonb("steps").notNull(),
    stepCount: integer("step_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("replay_scripts_owner_id_idx").on(table.ownerId),
    index("replay_scripts_agent_id_idx").on(table.agentId),
    uniqueIndex("replay_scripts_source_run_idx").on(table.sourceRunId),
    check("replay_scripts_name_check", sql`char_length(${table.name}) between 1 and 80`),
    check("replay_scripts_step_count_check", sql`${table.stepCount} between 1 and 20`),
  ],
);

// TASK-044. An approved repair appends one immutable version of a replay script. Version 1 is the base replay_scripts row;
// version n >= 2 is the steps of the approved proposal with that version. The source run is the repair that proved them.
export const replayScriptVersions = pgTable(
  "replay_script_versions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    scriptId: uuid("script_id").notNull().references(() => replayScripts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    steps: jsonb("steps").notNull(),
    stepCount: integer("step_count").notNull(),
    sourceRunId: uuid("source_run_id").notNull().references(() => runs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("replay_script_versions_owner_id_idx").on(table.ownerId),
    index("replay_script_versions_script_id_idx").on(table.scriptId),
    uniqueIndex("replay_script_versions_script_version_idx").on(table.scriptId, table.version),
    check("replay_script_versions_version_check", sql`${table.version} >= 2`),
    check("replay_script_versions_step_count_check", sql`${table.stepCount} between 1 and 20`),
  ],
);

// TASK-044. One owner review of a self-heal repair: the steps the repair run proved, based on the version the replay
// actually ran. At most one pending proposal per script. Runs and receipts are never touched when a script is deleted.
export const replayScriptProposals = pgTable(
  "replay_script_proposals",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    scriptId: uuid("script_id").notNull().references(() => replayScripts.id, { onDelete: "cascade" }),
    baseVersion: integer("base_version").notNull(),
    proposedVersion: integer("proposed_version").notNull(),
    failedStep: integer("failed_step").notNull(),
    failureCode: text("failure_code").notNull(),
    replayRunId: uuid("replay_run_id").notNull().references(() => runs.id),
    healRunId: uuid("heal_run_id").notNull().references(() => runs.id),
    steps: jsonb("steps").notNull(),
    stepCount: integer("step_count").notNull(),
    status: text("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("replay_script_proposals_owner_id_idx").on(table.ownerId),
    index("replay_script_proposals_script_id_idx").on(table.scriptId),
    uniqueIndex("replay_script_proposals_heal_run_idx").on(table.healRunId),
    uniqueIndex("replay_script_proposals_pending_script_idx").on(table.scriptId).where(sql`${table.status} = 'pending'`),
    check("replay_script_proposals_versions_check", sql`${table.baseVersion} >= 1 and ${table.proposedVersion} = ${table.baseVersion} + 1`),
    check("replay_script_proposals_failed_step_check", sql`${table.failedStep} between 1 and 20`),
    check("replay_script_proposals_step_count_check", sql`${table.stepCount} between 1 and 20`),
    check("replay_script_proposals_status_check", sql`${table.status} in ('pending', 'approved', 'rejected')`),
    check("replay_script_proposals_failure_code_check", sql`${table.failureCode} in ('target_missing', 'ambiguous_target', 'target_changed', 'unsupported_focus', 'postcondition_failed', 'postcondition_unknown')`),
  ],
);

// TASK-042. How a run was started. The signed run header is proof and never changes, so trigger, routine, retry and a
// display label live beside it. Insert-only for the app role: a run's metadata is written once, right after its run id exists.
// `agent_id` has no foreign key for the same reason as `runs`: the proof outlives the agent.
export const runMeta = pgTable(
  "run_meta",
  {
    runId: uuid("run_id").primaryKey().references(() => runs.id),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    trigger: text("trigger").notNull(),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    // TASK-039: scheduled/manual queue executions share one id across retries; no unique constraint.
    executionId: uuid("execution_id"),
    replayScriptId: uuid("replay_script_id").references(() => replayScripts.id, { onDelete: "set null" }),
    retryOf: uuid("retry_of").references(() => runs.id),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("run_meta_owner_id_idx").on(table.ownerId),
    index("run_meta_owner_execution_idx").on(table.ownerId, table.executionId),
    index("run_meta_retry_of_idx").on(table.retryOf),
    check("run_meta_trigger_check", sql`${table.trigger} in ('chat', 'run_now', 'schedule', 'replay', 'branch', 'heal')`),
    check("run_meta_label_check", sql`${table.label} is null or char_length(${table.label}) between 1 and 120`),
  ],
);

// TASK-050. One owner decision request. `agent_id` has no foreign key so the record survives agent deletion. Control
// names are page-derived text, bounded by the check; nothing that came from a page is used as a key.
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id"),
    actionClass: text("action_class").notNull(),
    site: text("site").notNull().default(""),
    controlName: text("control_name").notNull(),
    state: text("state").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("approvals_owner_id_idx").on(table.ownerId),
    check("approvals_action_class_check", sql`${table.actionClass} in ('download', 'send', 'post', 'delete', 'purchase', 'submit')`),
    check("approvals_state_check", sql`${table.state} in ('pending', 'allowed_once', 'always_allowed', 'denied', 'expired', 'stale', 'auto_allowed')`),
    check("approvals_site_check", sql`char_length(${table.site}) <= 255`),
    check("approvals_control_name_check", sql`char_length(${table.controlName}) between 1 and 120`),
  ],
);

// TASK-052. One hash chain per owner, signed per entry. Append-only for the app role; `agent_id` has no foreign key so
// the record outlives the agent. The canonical entry text is stored so it can be re-hashed and verified offline.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    agentId: uuid("agent_id"),
    runId: uuid("run_id"),
    ref: text("ref"),
    code: text("code"),
    host: text("host"),
    sourceRef: text("source_ref"),
    entryJson: text("entry_json").notNull(),
    entryHash: text("entry_hash").notNull(),
    prevHash: text("prev_hash").notNull(),
    signature: text("signature").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_owner_created_idx").on(table.ownerId, table.createdAt.desc()),
    uniqueIndex("audit_log_owner_seq_idx").on(table.ownerId, table.seq),
    uniqueIndex("audit_log_owner_source_ref_idx").on(table.ownerId, table.sourceRef).where(sql`${table.sourceRef} is not null`),
    check("audit_log_seq_check", sql`${table.seq} > 0`),
    check("audit_log_kind_check", sql`${table.kind} in ('tripwire', 'scope_blocked', 'egress_blocked', 'approval_denied', 'agent_stopped', 'crew_stopped', 'crew_resumed', 'login', 'password_changed', 'email_changed', 'sessions_revoked', 'agent_created', 'agent_updated', 'agent_paused', 'agent_resumed', 'agent_deleted', 'astra_enabled', 'astra_disabled', 'approval_allowed', 'permission_revoked', 'memory_approved', 'memory_rejected', 'memory_undone', 'connection_added', 'connection_replaced', 'connection_removed', 'composio_key_saved', 'composio_key_removed', 'composio_account_connected', 'composio_account_revoked')`),
    check("audit_log_code_check", sql`${table.code} is null or ${table.code} ~ '^[a-z_]{1,48}$'`),
    check("audit_log_hash_check", sql`${table.entryHash} ~ '^[0-9a-f]{64}$' and ${table.prevHash} ~ '^[0-9a-f]{64}$' and ${table.keyId} ~ '^sha256:[0-9a-f]{64}$'`),
    check("audit_log_signature_check", sql`${table.signature} ~ '^[A-Za-z0-9_-]+$'`),
    check("audit_log_ref_check", sql`${table.ref} is null or char_length(${table.ref}) between 1 and 120`),
    check("audit_log_host_check", sql`${table.host} is null or char_length(${table.host}) between 1 and 253`),
  ],
);

// TASK-053. Owner-approved memory. SOUL.md stays in agents.soul_md (one source of truth); the other three documents
// are entry lists. Every change appends an immutable version; the entry table holds current state.
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    doc: text("doc").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    visibleTo: uuid("visible_to").array().notNull().default(sql`'{}'::uuid[]`),
    title: text("title").notNull(),
    body: text("body").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    trusted: boolean("trusted").notNull().default(true),
    status: text("status").notNull().default("active"),
    author: text("author").notNull(),
    sourceRunId: uuid("source_run_id"),
    sourceLabel: text("source_label"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memory_entries_owner_id_idx").on(table.ownerId),
    index("memory_entries_owner_doc_idx").on(table.ownerId, table.doc),
    index("memory_entries_owner_agent_idx").on(table.ownerId, table.agentId),
    check("memory_entries_doc_check", sql`${table.doc} in ('user', 'memory', 'private')`),
    check("memory_entries_scope_check", sql`${table.scope} in ('global', 'agent', 'private')`),
    check("memory_entries_shape_check", sql`(${table.doc} = 'user' and ${table.scope} = 'global' and ${table.agentId} is null and cardinality(${table.visibleTo}) = 0) or (${table.doc} = 'memory' and ${table.scope} = 'agent' and ${table.agentId} is not null and cardinality(${table.visibleTo}) = 0) or (${table.doc} = 'private' and ${table.scope} = 'private' and ${table.agentId} is not null)`),
    check("memory_entries_visible_check", sql`cardinality(${table.visibleTo}) <= 10`),
    check("memory_entries_title_check", sql`char_length(${table.title}) between 1 and 80`),
    check("memory_entries_body_check", sql`char_length(${table.body}) between 1 and 600`),
    check("memory_entries_status_check", sql`${table.status} in ('active', 'archived')`),
    check("memory_entries_author_check", sql`${table.author} in ('owner', 'agent')`),
    check("memory_entries_source_label_check", sql`${table.sourceLabel} is null or char_length(${table.sourceLabel}) between 1 and 120`),
    check("memory_entries_version_check", sql`${table.version} >= 1`),
  ],
);

// TASK-053. Append-only change log per document. `before`/`after` are entry snapshots; an undo is a new row.
export const memoryVersions = pgTable(
  "memory_versions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    docKey: text("doc_key").notNull(),
    seq: integer("seq").notNull(),
    entryId: uuid("entry_id"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    op: text("op").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    author: text("author").notNull(),
    authorAgentId: uuid("author_agent_id"),
    reason: text("reason"),
    sourceRunId: uuid("source_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memory_versions_owner_id_idx").on(table.ownerId),
    index("memory_versions_owner_doc_idx").on(table.ownerId, table.docKey),
    uniqueIndex("memory_versions_owner_doc_seq_idx").on(table.ownerId, table.docKey, table.seq),
    check("memory_versions_seq_check", sql`${table.seq} >= 1`),
    check("memory_versions_doc_key_check", sql`${table.docKey} = 'user' or ${table.docKey} ~ '^agent:[0-9a-f-]{36}:(memory|private|soul)$'`),
    check("memory_versions_op_check", sql`${table.op} in ('add', 'edit', 'remove', 'pin', 'unpin', 'soul_edit', 'undo')`),
    check("memory_versions_before_check", sql`${table.before} is null or jsonb_typeof(${table.before}) = 'object'`),
    check("memory_versions_after_check", sql`${table.after} is null or jsonb_typeof(${table.after}) = 'object'`),
    check("memory_versions_author_check", sql`${table.author} in ('owner', 'agent')`),
    check("memory_versions_reason_check", sql`${table.reason} is null or char_length(${table.reason}) between 1 and 200`),
  ],
);

// TASK-054. An agent's add-only memory request. It never writes memory itself; only an owner decision applies it,
// in one transaction with its version row. `agent_id` cascades because the request is scoped to that agent.
export const memoryChanges = pgTable(
  "memory_changes",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    doc: text("doc").notNull(),
    scope: text("scope").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    reason: text("reason").notNull(),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    state: text("state").notNull().default("pending"),
    resultVersionId: uuid("result_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    index("memory_changes_owner_id_idx").on(table.ownerId),
    index("memory_changes_owner_agent_idx").on(table.ownerId, table.agentId),
    index("memory_changes_owner_state_idx").on(table.ownerId, table.state),
    check("memory_changes_doc_check", sql`${table.doc} in ('user', 'memory', 'private')`),
    check("memory_changes_scope_check", sql`${table.scope} in ('global', 'agent', 'private')`),
    check("memory_changes_title_check", sql`char_length(${table.title}) between 1 and 80`),
    check("memory_changes_body_check", sql`char_length(${table.body}) between 1 and 600`),
    check("memory_changes_reason_check", sql`char_length(${table.reason}) between 1 and 120`),
    check("memory_changes_flags_check", sql`cardinality(${table.flags}) <= 8`),
    check("memory_changes_state_check", sql`${table.state} in ('pending', 'approved', 'rejected')`),
  ],
);

// TASK-050. A scoped "Always allow": exactly one agent, one exact host and one action class. Revoking sets `revoked_at`;
// history and receipts are never rewritten. The partial unique index allows a new grant after a revoke.
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    site: text("site").notNull(),
    actionClass: text("action_class").notNull(),
    maxPerDay: integer("max_per_day").notNull().default(20),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("permissions_owner_id_idx").on(table.ownerId),
    uniqueIndex("permissions_active_idx").on(table.agentId, table.site, table.actionClass).where(sql`${table.revokedAt} is null`),
    check("permissions_action_class_check", sql`${table.actionClass} in ('download', 'send', 'post', 'delete', 'purchase', 'submit')`),
    check("permissions_site_check", sql`char_length(${table.site}) between 1 and 255`),
    check("permissions_max_per_day_check", sql`${table.maxPerDay} between 1 and 1000`),
  ],
);

// TASK-070. One saved token per agent for a tool host. `bindings` lists the exact hosts the token may be sent to
// (scheme and header included); the ciphertext is decrypted only to push the token to the egress proxy, which keeps
// it in memory. No model, browser, desktop process, log or receipt ever receives it.
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    preset: text("preset").notNull(),
    label: text("label").notNull(),
    bindings: jsonb("bindings").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    tokenHint: text("token_hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("connections_owner_id_idx").on(table.ownerId),
    uniqueIndex("connections_agent_label_idx").on(table.agentId, table.label),
    check("connections_preset_check", sql`${table.preset} in ('github', 'custom')`),
    check("connections_label_check", sql`char_length(${table.label}) between 1 and 60`),
    check("connections_bindings_check", sql`jsonb_typeof(${table.bindings}) = 'array' and jsonb_array_length(${table.bindings}) between 1 and 4`),
  ],
);

// TASK-075. Composio is owner-level and opt-in. The key is encrypted here and injected only at the egress proxy;
// connected-app tokens are held by Composio, never on this machine.
export const composioKeys = pgTable(
  "composio_keys",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    keyHint: text("key_hint").notNull(),
    injectionCheck: boolean("injection_check").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("composio_keys_owner_idx").on(table.ownerId),
    check("composio_keys_hint_check", sql`char_length(${table.keyHint}) between 1 and 32`),
  ],
);

// TASK-075. One connected account per agent and toolkit. The owner reviews and pins the tool list before any call.
export const composioAccounts = pgTable(
  "composio_accounts",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toolkit: text("toolkit").notNull(),
    connectedAccountId: text("connected_account_id"),
    status: text("status").notNull().default("pending"),
    toolsHash: text("tools_hash"),
    tools: jsonb("tools"),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("composio_accounts_owner_id_idx").on(table.ownerId),
    index("composio_accounts_owner_agent_idx").on(table.ownerId, table.agentId),
    uniqueIndex("composio_accounts_agent_toolkit_idx").on(table.agentId, table.toolkit),
    check("composio_accounts_toolkit_check", sql`${table.toolkit} ~ '^[a-z0-9_]{2,40}$'`),
    check("composio_accounts_status_check", sql`${table.status} in ('pending', 'active', 'failed', 'revoked', 'changed')`),
    check("composio_accounts_tools_check", sql`${table.tools} is null or (jsonb_typeof(${table.tools}) = 'array' and pg_column_size(${table.tools}) <= 262144)`),
    check("composio_accounts_tools_hash_check", sql`${table.toolsHash} is null or ${table.toolsHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

// TASK-072. One pinned remote MCP server per agent key. The tool snapshot and its hash are stored so a server that
// changes its tool list is blocked until the owner reviews and re-pins it. The URL host must match a connection binding.
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    preset: text("preset").notNull(),
    url: text("url").notNull(),
    connectionId: uuid("connection_id").notNull().references(() => connections.id, { onDelete: "restrict" }),
    serverName: text("server_name").notNull(),
    serverVersion: text("server_version").notNull(),
    protocolVersion: text("protocol_version").notNull(),
    toolsHash: text("tools_hash").notNull(),
    tools: jsonb("tools").notNull(),
    status: text("status").notNull().default("pinned"),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_servers_owner_id_idx").on(table.ownerId),
    uniqueIndex("mcp_servers_agent_key_idx").on(table.agentId, table.key),
    check("mcp_servers_key_check", sql`${table.key} ~ '^[a-z0-9-]{1,32}$'`),
    check("mcp_servers_preset_check", sql`${table.preset} in ('github', 'custom')`),
    check("mcp_servers_url_check", sql`${table.url} ~ '^https://[^[:space:]]+$' and char_length(${table.url}) <= 2048`),
    check("mcp_servers_status_check", sql`${table.status} in ('pinned', 'changed', 'disabled')`),
    check("mcp_servers_tools_hash_check", sql`${table.toolsHash} ~ '^[0-9a-f]{64}$'`),
    check("mcp_servers_tools_check", sql`jsonb_typeof(${table.tools}) = 'array' and pg_column_size(${table.tools}) <= 262144`),
  ],
);


// TASK-050. One row per use of a grant. Counting is a rolling 24 hours; the 21st use asks the owner again.
export const permissionUses = pgTable(
  "permission_uses",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    permissionId: uuid("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("permission_uses_permission_used_idx").on(table.permissionId, table.usedAt),
  ],
);
