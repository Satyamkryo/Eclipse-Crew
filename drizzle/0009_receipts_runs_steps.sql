CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"branch_of" uuid,
	"header_json" text NOT NULL,
	"header_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"public_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"ended_at" timestamp with time zone,
	"step_count" integer,
	"head_hash" text,
	"usage" jsonb,
	"signature" text,
	CONSTRAINT "runs_sealed_check" CHECK (("runs"."signature" is null and "runs"."ended_at" is null and "runs"."step_count" is null and "runs"."head_hash" is null and "runs"."usage" is null) or ("runs"."signature" is not null and "runs"."ended_at" is not null and "runs"."step_count" is not null and "runs"."head_hash" is not null and "runs"."usage" is not null))
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"receipt_json" text NOT NULL,
	"receipt_hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_owner_id_idx" ON "runs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "steps_owner_id_idx" ON "steps" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_run_idx_idx" ON "steps" USING btree ("run_id","idx");