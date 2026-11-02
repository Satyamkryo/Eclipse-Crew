CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"reference_shots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_source_check" CHECK ("skill_versions"."source" in ('video', 'steps_screenshots')),
	CONSTRAINT "skill_versions_version_check" CHECK ("skill_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body" text NOT NULL,
	"reference_shots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_capture_id_unique" UNIQUE("capture_id"),
	CONSTRAINT "skills_source_check" CHECK ("skills"."source" in ('video', 'steps_screenshots')),
	CONSTRAINT "skills_status_check" CHECK ("skills"."status" in ('draft', 'cleanup_pending', 'approved')),
	CONSTRAINT "skills_version_check" CHECK ("skills"."version" > 0),
	CONSTRAINT "skills_name_check" CHECK ("skills"."name" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "cost_entries" DROP CONSTRAINT "cost_entries_idempotency_check";--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_versions_owner_id_idx" ON "skill_versions" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_idx" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skills_owner_id_idx" ON "skills" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "skills_agent_id_idx" ON "skills" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_agent_name_idx" ON "skills" USING btree ("owner_id","agent_id","name");--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_idempotency_check" CHECK (("cost_entries"."run_id" is not null and "cost_entries"."idempotency_key" = 'cost:' || "cost_entries"."run_id"::text || ':' || "cost_entries"."call_index"::text) or ("cost_entries"."capture_id" is not null and ("cost_entries"."idempotency_key" = 'teach:' || "cost_entries"."capture_id"::text || ':asr:' || ("cost_entries"."call_index" - 1)::text or "cost_entries"."idempotency_key" = 'teach:' || "cost_entries"."capture_id"::text || ':skill:' || "cost_entries"."call_index"::text)));