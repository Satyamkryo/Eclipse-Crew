CREATE TABLE "crews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crews_name_check" CHECK (char_length("crews"."name") between 1 and 80),
	CONSTRAINT "crews_description_check" CHECK (char_length("crews"."description") between 0 and 500)
);
--> statement-breakpoint
CREATE TABLE "crew_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"crew_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"role" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_members_name_check" CHECK (char_length("crew_members"."agent_name") between 1 and 80),
	CONSTRAINT "crew_members_role_check" CHECK (char_length("crew_members"."role") between 1 and 80),
	CONSTRAINT "crew_members_state_check" CHECK ("crew_members"."state" in ('pending', 'creating', 'ready', 'failed')),
	CONSTRAINT "crew_members_error_check" CHECK ("crew_members"."error_code" is null or "crew_members"."error_code" ~ '^[a-z_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crews_owner_id_idx" ON "crews" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "crew_members_owner_id_idx" ON "crew_members" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "crew_members_crew_id_idx" ON "crew_members" USING btree ("crew_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_members_crew_agent_idx" ON "crew_members" USING btree ("crew_id","agent_id");
