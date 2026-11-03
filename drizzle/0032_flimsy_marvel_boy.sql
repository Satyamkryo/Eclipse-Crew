CREATE TABLE "crew_report_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_report_deliveries_timezone_check" CHECK (char_length("crew_report_deliveries"."timezone") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "crew_report_settings" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"recipient_agent_id" uuid,
	"local_time" text DEFAULT '09:00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_report_settings_time_check" CHECK ("crew_report_settings"."local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "starter_crew_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"setup_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starter_crew_members_template_check" CHECK ("starter_crew_members"."template_id" in ('pr-reviewer', 'dev-agent', 'daily-briefer', 'inbox-triage', 'research-analyst', 'travel-assistant')),
	CONSTRAINT "starter_crew_members_state_check" CHECK ("starter_crew_members"."state" in ('pending', 'creating', 'created', 'failed')),
	CONSTRAINT "starter_crew_members_error_check" CHECK ("starter_crew_members"."error_code" is null or "starter_crew_members"."error_code" ~ '^[a-z_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "starter_crew_setups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"state" text DEFAULT 'creating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starter_crew_setups_state_check" CHECK ("starter_crew_setups"."state" in ('creating', 'partial', 'complete'))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_type_check";--> statement-breakpoint
ALTER TABLE "crew_report_deliveries" ADD CONSTRAINT "crew_report_deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_report_settings" ADD CONSTRAINT "crew_report_settings_recipient_agent_id_agents_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starter_crew_members" ADD CONSTRAINT "starter_crew_members_setup_id_starter_crew_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."starter_crew_setups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_report_deliveries_owner_id_idx" ON "crew_report_deliveries" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_report_deliveries_owner_scheduled_idx" ON "crew_report_deliveries" USING btree ("owner_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "starter_crew_members_owner_id_idx" ON "starter_crew_members" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "starter_crew_members_setup_template_idx" ON "starter_crew_members" USING btree ("setup_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "starter_crew_setups_owner_idx" ON "starter_crew_setups" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused', 'teach_paused', 'skill_update', 'approval', 'memory_change', 'memory_saved', 'memory_tidied', 'crew_report'));