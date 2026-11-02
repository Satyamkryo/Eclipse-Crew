CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"state_hash" text NOT NULL,
	"manifest_hash" text,
	"file_count" integer DEFAULT 0 NOT NULL,
	"restorable_count" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_status_check" CHECK ("checkpoints"."status" in ('complete', 'partial'))
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkpoints_owner_id_idx" ON "checkpoints" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoints_run_idx_idx" ON "checkpoints" USING btree ("run_id","idx");