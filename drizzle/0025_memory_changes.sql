CREATE TABLE "memory_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"doc" text NOT NULL,
	"scope" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"reason" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "memory_changes_doc_check" CHECK ("memory_changes"."doc" in ('user', 'memory', 'private')),
	CONSTRAINT "memory_changes_scope_check" CHECK ("memory_changes"."scope" in ('global', 'agent', 'private')),
	CONSTRAINT "memory_changes_title_check" CHECK (char_length("memory_changes"."title") between 1 and 80),
	CONSTRAINT "memory_changes_body_check" CHECK (char_length("memory_changes"."body") between 1 and 600),
	CONSTRAINT "memory_changes_reason_check" CHECK (char_length("memory_changes"."reason") between 1 and 120),
	CONSTRAINT "memory_changes_flags_check" CHECK (cardinality("memory_changes"."flags") <= 8),
	CONSTRAINT "memory_changes_state_check" CHECK ("memory_changes"."state" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_kind_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_type_check";--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_changes_owner_id_idx" ON "memory_changes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "memory_changes_owner_agent_idx" ON "memory_changes" USING btree ("owner_id","agent_id");--> statement-breakpoint
CREATE INDEX "memory_changes_owner_state_idx" ON "memory_changes" USING btree ("owner_id","state");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_kind_check" CHECK ("audit_log"."kind" in ('tripwire', 'scope_blocked', 'egress_blocked', 'approval_denied', 'agent_stopped', 'crew_stopped', 'crew_resumed', 'login', 'password_changed', 'email_changed', 'sessions_revoked', 'agent_created', 'agent_updated', 'agent_paused', 'agent_resumed', 'agent_deleted', 'astra_enabled', 'astra_disabled', 'approval_allowed', 'permission_revoked', 'memory_approved', 'memory_rejected', 'memory_undone'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused', 'teach_paused', 'skill_update', 'approval', 'memory_change'));--> statement-breakpoint
-- TASK-054. Agents whose owner already allowed some actions also get `remember`. Empty lists stay fully denied.
UPDATE "agent_policies"
SET "actions" = "actions" || ARRAY['remember'],
    "updated_at" = now()
WHERE cardinality("actions") > 0
  AND cardinality("actions") <= 63
  AND NOT ("actions" @> ARRAY['remember']);
