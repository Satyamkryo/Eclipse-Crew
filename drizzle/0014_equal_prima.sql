CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"skill_id" uuid,
	"goal" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule" text NOT NULL,
	"schedule_spec" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"budget_cents" integer NOT NULL,
	"catch_up" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"mode" text DEFAULT 'cron' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routines_source_message_id_unique" UNIQUE("source_message_id"),
	CONSTRAINT "routines_catch_up_check" CHECK ("routines"."catch_up" in ('skip', 'run_once', 'run_all')),
	CONSTRAINT "routines_mode_check" CHECK ("routines"."mode" = 'cron'),
	CONSTRAINT "routines_budget_check" CHECK ("routines"."budget_cents" between 1 and 100000000),
	CONSTRAINT "routines_schedule_check" CHECK (char_length("routines"."schedule") between 1 and 200 and char_length("routines"."timezone") between 1 and 100 and jsonb_typeof("routines"."steps") = 'array')
);
--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routines_owner_id_idx" ON "routines" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "routines_agent_id_idx" ON "routines" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "routines_owner_next_run_idx" ON "routines" USING btree ("owner_id","next_run_at");