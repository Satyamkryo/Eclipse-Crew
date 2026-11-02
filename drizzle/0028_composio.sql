CREATE TABLE "composio_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"toolkit" text NOT NULL,
	"connected_account_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"tools_hash" text,
	"tools" jsonb,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_accounts_toolkit_check" CHECK ("composio_accounts"."toolkit" ~ '^[a-z0-9_]{2,40}$'),
	CONSTRAINT "composio_accounts_status_check" CHECK ("composio_accounts"."status" in ('pending', 'active', 'failed', 'revoked', 'changed')),
	CONSTRAINT "composio_accounts_tools_check" CHECK ("composio_accounts"."tools" is null or (jsonb_typeof("composio_accounts"."tools") = 'array' and pg_column_size("composio_accounts"."tools") <= 262144)),
	CONSTRAINT "composio_accounts_tools_hash_check" CHECK ("composio_accounts"."tools_hash" is null or "composio_accounts"."tools_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "composio_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_hint" text NOT NULL,
	"injection_check" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_keys_hint_check" CHECK (char_length("composio_keys"."key_hint") between 1 and 32)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_kind_check";--> statement-breakpoint
ALTER TABLE "composio_accounts" ADD CONSTRAINT "composio_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "composio_accounts_owner_id_idx" ON "composio_accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "composio_accounts_owner_agent_idx" ON "composio_accounts" USING btree ("owner_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "composio_accounts_agent_toolkit_idx" ON "composio_accounts" USING btree ("agent_id","toolkit");--> statement-breakpoint
CREATE UNIQUE INDEX "composio_keys_owner_idx" ON "composio_keys" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_kind_check" CHECK ("audit_log"."kind" in ('tripwire', 'scope_blocked', 'egress_blocked', 'approval_denied', 'agent_stopped', 'crew_stopped', 'crew_resumed', 'login', 'password_changed', 'email_changed', 'sessions_revoked', 'agent_created', 'agent_updated', 'agent_paused', 'agent_resumed', 'agent_deleted', 'astra_enabled', 'astra_disabled', 'approval_allowed', 'permission_revoked', 'memory_approved', 'memory_rejected', 'memory_undone', 'connection_added', 'connection_replaced', 'connection_removed', 'composio_key_saved', 'composio_key_removed', 'composio_account_connected', 'composio_account_revoked'));