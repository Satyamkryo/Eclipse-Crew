CREATE TABLE "agent_canaries" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"encrypted_canary" text NOT NULL,
	"canary_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"planted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"run_id" uuid,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_events_source_ref_unique" UNIQUE("source_ref"),
	CONSTRAINT "security_events_kind_check" CHECK ("security_events"."kind" = 'canary_leak'),
	CONSTRAINT "security_events_source_check" CHECK ("security_events"."source" in ('typed_text', 'proxy_host', 'proxy_request'))
);
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_attention_reason_check";--> statement-breakpoint
ALTER TABLE "agent_canaries" ADD CONSTRAINT "agent_canaries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_canaries_owner_id_idx" ON "agent_canaries" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_canaries_sha256_idx" ON "agent_canaries" USING btree ("canary_sha256");--> statement-breakpoint
CREATE INDEX "security_events_owner_created_idx" ON "security_events" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_attention_reason_check" CHECK ("agents"."attention_reason" is null or "agents"."attention_reason" in ('budget_warning', 'budget_paused', 'security_stop'));