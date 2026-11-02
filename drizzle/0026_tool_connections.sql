-- TASK-070. Tool connections: one encrypted token per agent for up to four exact tool hosts.
-- Runtime role eclipse_app: SELECT, INSERT, UPDATE, DELETE (owner-managed rows; the ciphertext is pushed to the
-- egress proxy in memory only, never read by the browser, desktop, a model, a log or a receipt).
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"preset" text NOT NULL,
	"label" text NOT NULL,
	"bindings" jsonb NOT NULL,
	"encrypted_token" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_preset_check" CHECK ("connections"."preset" in ('github', 'custom')),
	CONSTRAINT "connections_label_check" CHECK (char_length("connections"."label") between 1 and 60),
	CONSTRAINT "connections_bindings_check" CHECK (jsonb_typeof("connections"."bindings") = 'array' and jsonb_array_length("connections"."bindings") between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_kind_check";--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_owner_id_idx" ON "connections" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_agent_label_idx" ON "connections" USING btree ("agent_id","label");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_kind_check" CHECK ("audit_log"."kind" in ('tripwire', 'scope_blocked', 'egress_blocked', 'approval_denied', 'agent_stopped', 'crew_stopped', 'crew_resumed', 'login', 'password_changed', 'email_changed', 'sessions_revoked', 'agent_created', 'agent_updated', 'agent_paused', 'agent_resumed', 'agent_deleted', 'astra_enabled', 'astra_disabled', 'approval_allowed', 'permission_revoked', 'memory_approved', 'memory_rejected', 'memory_undone', 'connection_added', 'connection_replaced', 'connection_removed'));