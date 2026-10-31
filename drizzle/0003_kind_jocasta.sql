CREATE TABLE "agent_policies" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"actions" text[] DEFAULT '{}'::text[] NOT NULL,
	"memory_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_policies_tools_check" CHECK (cardinality("agent_policies"."tools") <= 64),
	CONSTRAINT "agent_policies_domains_check" CHECK (cardinality("agent_policies"."domains") <= 64),
	CONSTRAINT "agent_policies_actions_check" CHECK (cardinality("agent_policies"."actions") <= 64),
	CONSTRAINT "agent_policies_memory_scopes_check" CHECK (cardinality("agent_policies"."memory_scopes") <= 3)
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"soul_md" text NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"daily_budget_cents" integer NOT NULL,
	"monthly_budget_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" in ('active', 'paused')),
	CONSTRAINT "agents_daily_budget_check" CHECK ("agents"."daily_budget_cents" between 1 and 100000000),
	CONSTRAINT "agents_monthly_budget_check" CHECK ("agents"."monthly_budget_cents" between 1 and 100000000)
);
--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_policies_owner_id_idx" ON "agent_policies" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_owner_id_idx" ON "agents" USING btree ("owner_id");