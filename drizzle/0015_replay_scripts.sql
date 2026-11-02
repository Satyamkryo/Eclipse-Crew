CREATE TABLE "replay_scripts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"step_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replay_scripts_name_check" CHECK (char_length("replay_scripts"."name") between 1 and 80),
	CONSTRAINT "replay_scripts_step_count_check" CHECK ("replay_scripts"."step_count" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "replay_scripts" ADD CONSTRAINT "replay_scripts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_scripts" ADD CONSTRAINT "replay_scripts_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replay_scripts_owner_id_idx" ON "replay_scripts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "replay_scripts_agent_id_idx" ON "replay_scripts" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_scripts_source_run_idx" ON "replay_scripts" USING btree ("source_run_id");