ALTER TABLE "agent_policies" ADD COLUMN "any_public_web" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_soul_md_length_check" CHECK (char_length("agents"."soul_md") <= 2000);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_instructions_length_check" CHECK (char_length("agents"."instructions") <= 4000);--> statement-breakpoint
-- ADR-036. The old single 'persona' text was really the agent's instructions: move it, and start Persona empty.
UPDATE "agents" SET "instructions" = "soul_md", "soul_md" = '' WHERE "instructions" = '';
