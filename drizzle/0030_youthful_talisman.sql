CREATE TABLE "github_device_flows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"label" text NOT NULL,
	"encrypted_device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"verification_uri" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"connection_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_device_flows_label_check" CHECK (char_length("github_device_flows"."label") between 1 and 60),
	CONSTRAINT "github_device_flows_user_code_check" CHECK ("github_device_flows"."user_code" ~ '^[A-Z0-9-]{4,32}$'),
	CONSTRAINT "github_device_flows_uri_check" CHECK ("github_device_flows"."verification_uri" ~ '^https://github\.com/'),
	CONSTRAINT "github_device_flows_interval_check" CHECK ("github_device_flows"."interval_seconds" between 1 and 60),
	CONSTRAINT "github_device_flows_status_check" CHECK ("github_device_flows"."status" in ('pending', 'connected', 'expired', 'denied', 'error')),
	CONSTRAINT "github_device_flows_error_check" CHECK ("github_device_flows"."error_code" is null or char_length("github_device_flows"."error_code") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_kind_check";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "encrypted_refresh_token" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "refresh_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "source" text DEFAULT 'pasted' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_device_flows" ADD CONSTRAINT "github_device_flows_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_device_flows" ADD CONSTRAINT "github_device_flows_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_device_flows_owner_idx" ON "github_device_flows" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "github_device_flows_agent_idx" ON "github_device_flows" USING btree ("owner_id","agent_id");--> statement-breakpoint
CREATE INDEX "github_device_flows_status_idx" ON "github_device_flows" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_kind_check" CHECK ("audit_log"."kind" in ('tripwire', 'scope_blocked', 'egress_blocked', 'approval_denied', 'agent_stopped', 'crew_stopped', 'crew_resumed', 'login', 'password_changed', 'email_changed', 'sessions_revoked', 'agent_created', 'agent_updated', 'agent_paused', 'agent_resumed', 'agent_deleted', 'astra_enabled', 'astra_disabled', 'approval_allowed', 'permission_revoked', 'memory_approved', 'memory_rejected', 'memory_undone', 'memory_auto_saved', 'memory_tidied', 'memory_upgrade_applied', 'connection_added', 'connection_replaced', 'connection_removed', 'connection_device_started', 'connection_device_connected', 'connection_device_expired', 'composio_key_saved', 'composio_key_removed', 'composio_account_connected', 'composio_account_revoked'));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_source_check" CHECK ("connections"."source" in ('pasted', 'github_app'));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('active', 'expired'));