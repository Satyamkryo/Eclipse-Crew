CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"action_class" text NOT NULL,
	"site" text DEFAULT '' NOT NULL,
	"control_name" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_action_class_check" CHECK ("approvals"."action_class" in ('download', 'send', 'post', 'delete', 'purchase', 'submit')),
	CONSTRAINT "approvals_state_check" CHECK ("approvals"."state" in ('pending', 'allowed_once', 'always_allowed', 'denied', 'expired', 'stale')),
	CONSTRAINT "approvals_site_check" CHECK (char_length("approvals"."site") <= 255),
	CONSTRAINT "approvals_control_name_check" CHECK (char_length("approvals"."control_name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "permission_uses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"run_id" uuid,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"site" text NOT NULL,
	"action_class" text NOT NULL,
	"max_per_day" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "permissions_action_class_check" CHECK ("permissions"."action_class" in ('download', 'send', 'post', 'delete', 'purchase', 'submit')),
	CONSTRAINT "permissions_site_check" CHECK (char_length("permissions"."site") between 1 and 255),
	CONSTRAINT "permissions_max_per_day_check" CHECK ("permissions"."max_per_day" between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_attention_reason_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_type_check";--> statement-breakpoint
ALTER TABLE "security_events" DROP CONSTRAINT "security_events_kind_check";--> statement-breakpoint
ALTER TABLE "security_events" DROP CONSTRAINT "security_events_source_check";--> statement-breakpoint
ALTER TABLE "permission_uses" ADD CONSTRAINT "permission_uses_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_owner_id_idx" ON "approvals" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "permission_uses_permission_used_idx" ON "permission_uses" USING btree ("permission_id","used_at");--> statement-breakpoint
CREATE INDEX "permissions_owner_id_idx" ON "permissions" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_active_idx" ON "permissions" USING btree ("agent_id","site","action_class") WHERE "permissions"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_attention_reason_check" CHECK ("agents"."attention_reason" is null or "agents"."attention_reason" in ('budget_warning', 'budget_paused', 'security_stop', 'approval_pending'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused', 'teach_paused', 'skill_update', 'approval'));--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_kind_check" CHECK ("security_events"."kind" in ('canary_leak', 'scope_blocked'));--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_source_check" CHECK ("security_events"."source" in ('typed_text', 'proxy_host', 'proxy_request', 'scope_host', 'scope_recipient', 'scope_page'));