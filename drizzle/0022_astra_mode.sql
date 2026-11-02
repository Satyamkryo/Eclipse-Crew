ALTER TABLE "approvals" DROP CONSTRAINT "approvals_state_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "astra_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_state_check" CHECK ("approvals"."state" in ('pending', 'allowed_once', 'always_allowed', 'denied', 'expired', 'stale', 'auto_allowed'));