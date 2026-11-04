ALTER TABLE "agents" ADD COLUMN "avatar_variant" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "agents" SET "avatar_variant" = floor(random() * 12)::integer;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_avatar_variant_check" CHECK ("agents"."avatar_variant" between 0 and 11);