CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"via" text DEFAULT 'fetch' NOT NULL,
	"goal" text,
	"urgent" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer NOT NULL,
	"window_start" integer NOT NULL,
	"window_end" integer NOT NULL,
	"timezone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"fingerprint" text,
	"snapshot" text,
	"quiet_streak" integer DEFAULT 0 NOT NULL,
	"pending_changes" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"next_check_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_ins_kind_check" CHECK ("check_ins"."kind" in ('sundance', 'moondance') and "check_ins"."via" in ('fetch', 'browser')),
	CONSTRAINT "check_ins_text_check" CHECK (char_length("check_ins"."name") between 1 and 80 and char_length("check_ins"."url") between 9 and 2000 and ("check_ins"."goal" is null or char_length("check_ins"."goal") between 1 and 2000) and char_length("check_ins"."timezone") between 1 and 100),
	CONSTRAINT "check_ins_window_check" CHECK ("check_ins"."window_start" between 0 and 23 and "check_ins"."window_end" between 0 and 23 and "check_ins"."window_start" <> "check_ins"."window_end"),
	CONSTRAINT "check_ins_interval_check" CHECK ("check_ins"."interval_minutes" between 5 and 720),
	CONSTRAINT "check_ins_state_check" CHECK (("check_ins"."fingerprint" is null or "check_ins"."fingerprint" ~ '^[0-9a-f]{64}$') and ("check_ins"."snapshot" is null or char_length("check_ins"."snapshot") <= 12000) and "check_ins"."quiet_streak" between 0 and 1000000 and "check_ins"."pending_changes" between 0 and 1000000),
	CONSTRAINT "check_ins_status_check" CHECK ("check_ins"."last_status" is null or "check_ins"."last_status" in ('first', 'unchanged', 'changed', 'failed', 'skipped', 'needs_login'))
);
--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_ins_owner_id_idx" ON "check_ins" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "check_ins_agent_id_idx" ON "check_ins" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "check_ins_owner_next_idx" ON "check_ins" USING btree ("owner_id","next_check_at");