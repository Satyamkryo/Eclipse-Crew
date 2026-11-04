ALTER TABLE "run_meta" DROP CONSTRAINT "run_meta_trigger_check";--> statement-breakpoint
ALTER TABLE "run_meta" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "run_meta" ADD CONSTRAINT "run_meta_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_meta_parent_run_idx" ON "run_meta" USING btree ("parent_run_id");--> statement-breakpoint
ALTER TABLE "run_meta" ADD CONSTRAINT "run_meta_trigger_check" CHECK ("run_meta"."trigger" in ('chat', 'run_now', 'schedule', 'replay', 'branch', 'heal', 'handoff', 'subagent'));
