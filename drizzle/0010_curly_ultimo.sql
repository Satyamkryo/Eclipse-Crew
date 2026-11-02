CREATE TABLE "step_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"before_hash" text,
	"after_hash" text,
	"width" integer,
	"height" integer,
	"sam_box" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "step_evidence" ADD CONSTRAINT "step_evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_evidence_owner_id_idx" ON "step_evidence" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "step_evidence_run_idx_idx" ON "step_evidence" USING btree ("run_id","idx");