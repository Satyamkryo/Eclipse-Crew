CREATE TABLE "replay_script_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"proposed_version" integer NOT NULL,
	"failed_step" integer NOT NULL,
	"failure_code" text NOT NULL,
	"replay_run_id" uuid NOT NULL,
	"heal_run_id" uuid NOT NULL,
	"steps" jsonb NOT NULL,
	"step_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replay_script_proposals_versions_check" CHECK ("replay_script_proposals"."base_version" >= 1 and "replay_script_proposals"."proposed_version" = "replay_script_proposals"."base_version" + 1),
	CONSTRAINT "replay_script_proposals_failed_step_check" CHECK ("replay_script_proposals"."failed_step" between 1 and 20),
	CONSTRAINT "replay_script_proposals_step_count_check" CHECK ("replay_script_proposals"."step_count" between 1 and 20),
	CONSTRAINT "replay_script_proposals_status_check" CHECK ("replay_script_proposals"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "replay_script_proposals_failure_code_check" CHECK ("replay_script_proposals"."failure_code" in ('target_missing', 'ambiguous_target', 'target_changed', 'unsupported_focus', 'postcondition_failed', 'postcondition_unknown'))
);
--> statement-breakpoint
CREATE TABLE "replay_script_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"step_count" integer NOT NULL,
	"source_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replay_script_versions_version_check" CHECK ("replay_script_versions"."version" >= 2),
	CONSTRAINT "replay_script_versions_step_count_check" CHECK ("replay_script_versions"."step_count" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_type_check";--> statement-breakpoint
ALTER TABLE "replay_script_proposals" ADD CONSTRAINT "replay_script_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_script_proposals" ADD CONSTRAINT "replay_script_proposals_script_id_replay_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."replay_scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_script_proposals" ADD CONSTRAINT "replay_script_proposals_replay_run_id_runs_id_fk" FOREIGN KEY ("replay_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_script_proposals" ADD CONSTRAINT "replay_script_proposals_heal_run_id_runs_id_fk" FOREIGN KEY ("heal_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_script_versions" ADD CONSTRAINT "replay_script_versions_script_id_replay_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."replay_scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_script_versions" ADD CONSTRAINT "replay_script_versions_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replay_script_proposals_owner_id_idx" ON "replay_script_proposals" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "replay_script_proposals_script_id_idx" ON "replay_script_proposals" USING btree ("script_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_script_proposals_heal_run_idx" ON "replay_script_proposals" USING btree ("heal_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_script_proposals_pending_script_idx" ON "replay_script_proposals" USING btree ("script_id") WHERE "replay_script_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "replay_script_versions_owner_id_idx" ON "replay_script_versions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "replay_script_versions_script_id_idx" ON "replay_script_versions" USING btree ("script_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_script_versions_script_version_idx" ON "replay_script_versions" USING btree ("script_id","version");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused', 'teach_paused', 'skill_update'));