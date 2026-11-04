CREATE TABLE "memory_review_state" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"last_message_id" uuid,
	"last_tidy_at" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_review_state_tidy_check" CHECK (jsonb_typeof("memory_review_state"."last_tidy_at") = 'object')
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_kind_check";--> statement-breakpoint
ALTER TABLE "memory_versions" DROP CONSTRAINT "memory_versions_op_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_type_check";--> statement-breakpoint
ALTER TABLE "model_roles" DROP CONSTRAINT "model_roles_role_check";--> statement-breakpoint
ALTER TABLE "agent_policies" ADD COLUMN "memory_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
UPDATE "agent_policies" SET "memory_mode" = 'ask';--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "op" text DEFAULT 'add' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "quote" text;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "last_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_review_state" ADD CONSTRAINT "memory_review_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_review_state_owner_idx" ON "memory_review_state" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "memory_versions_batch_idx" ON "memory_versions" USING btree ("owner_id","batch_id");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin (to_tsvector('simple', coalesce("content"->>'text','') || ' ' || coalesce("content"->>'question','')));--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_memory_mode_check" CHECK ("agent_policies"."memory_mode" in ('auto', 'ask'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_kind_check" CHECK ("audit_log"."kind" in ('tripwire', 'scope_blocked', 'egress_blocked', 'approval_denied', 'agent_stopped', 'crew_stopped', 'crew_resumed', 'login', 'password_changed', 'email_changed', 'sessions_revoked', 'agent_created', 'agent_updated', 'agent_paused', 'agent_resumed', 'agent_deleted', 'astra_enabled', 'astra_disabled', 'approval_allowed', 'permission_revoked', 'memory_approved', 'memory_rejected', 'memory_undone', 'memory_auto_saved', 'memory_tidied', 'memory_upgrade_applied', 'connection_added', 'connection_replaced', 'connection_removed', 'composio_key_saved', 'composio_key_removed', 'composio_account_connected', 'composio_account_revoked'));--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_op_check" CHECK ("memory_changes"."op" in ('add', 'replace', 'forget'));--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_quote_check" CHECK ("memory_changes"."quote" is null or char_length("memory_changes"."quote") between 12 and 600);--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_op_check" CHECK ("memory_versions"."op" in ('add', 'edit', 'remove', 'pin', 'unpin', 'soul_edit', 'undo', 'merge', 'shorten', 'archive'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused', 'teach_paused', 'skill_update', 'approval', 'memory_change', 'memory_saved', 'memory_tidied'));--> statement-breakpoint
ALTER TABLE "model_roles" ADD CONSTRAINT "model_roles_background_shape_check" CHECK ("model_roles"."role" <> 'background' or ("model_roles"."mode" = 'active' and "model_roles"."provider_id" is not null and "model_roles"."model" is not null and "model_roles"."use_main_key" = false));--> statement-breakpoint
ALTER TABLE "model_roles" ADD CONSTRAINT "model_roles_role_check" CHECK ("model_roles"."role" in ('main', 'sam', 'background'));