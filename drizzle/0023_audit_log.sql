CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"ref" text,
	"code" text,
	"host" text,
	"source_ref" text,
	"entry_json" text NOT NULL,
	"entry_hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"signature" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_seq_check" CHECK ("audit_log"."seq" > 0),
	CONSTRAINT "audit_log_kind_check" CHECK ("audit_log"."kind" in ('tripwire', 'scope_blocked', 'egress_blocked', 'approval_denied', 'agent_stopped', 'crew_stopped', 'crew_resumed', 'login', 'password_changed', 'email_changed', 'sessions_revoked', 'agent_created', 'agent_updated', 'agent_paused', 'agent_resumed', 'agent_deleted', 'astra_enabled', 'astra_disabled', 'approval_allowed', 'permission_revoked')),
	CONSTRAINT "audit_log_code_check" CHECK ("audit_log"."code" is null or "audit_log"."code" ~ '^[a-z_]{1,48}$'),
	CONSTRAINT "audit_log_hash_check" CHECK ("audit_log"."entry_hash" ~ '^[0-9a-f]{64}$' and "audit_log"."prev_hash" ~ '^[0-9a-f]{64}$' and "audit_log"."key_id" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "audit_log_signature_check" CHECK ("audit_log"."signature" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "audit_log_ref_check" CHECK ("audit_log"."ref" is null or char_length("audit_log"."ref") between 1 and 120),
	CONSTRAINT "audit_log_host_check" CHECK ("audit_log"."host" is null or char_length("audit_log"."host") between 1 and 253)
);
--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "crew_stopped_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_log_owner_created_idx" ON "audit_log" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_owner_seq_idx" ON "audit_log" USING btree ("owner_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_owner_source_ref_idx" ON "audit_log" USING btree ("owner_id","source_ref") WHERE "audit_log"."source_ref" is not null;