CREATE TABLE "run_meta" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"routine_id" uuid,
	"replay_script_id" uuid,
	"retry_of" uuid,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_meta_trigger_check" CHECK ("run_meta"."trigger" in ('chat', 'run_now', 'schedule', 'replay', 'branch', 'heal')),
	CONSTRAINT "run_meta_label_check" CHECK ("run_meta"."label" is null or char_length("run_meta"."label") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "run_meta" ADD CONSTRAINT "run_meta_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_meta" ADD CONSTRAINT "run_meta_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_meta" ADD CONSTRAINT "run_meta_replay_script_id_replay_scripts_id_fk" FOREIGN KEY ("replay_script_id") REFERENCES "public"."replay_scripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_meta" ADD CONSTRAINT "run_meta_retry_of_runs_id_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_meta_owner_id_idx" ON "run_meta" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "run_meta_retry_of_idx" ON "run_meta" USING btree ("retry_of");--> statement-breakpoint
CREATE INDEX "runs_owner_started_idx" ON "runs" USING btree ("owner_id","started_at" DESC NULLS LAST);