CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"card_type" text NOT NULL,
	"content" jsonb NOT NULL,
	"source_tag" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'agent', 'system')),
	CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine')),
	CONSTRAINT "messages_source_tag_check" CHECK ("messages"."source_tag" in ('user', 'agent', 'tool', 'system'))
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_sessions_owner_id_idx" ON "chat_sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_owner_agent_idx" ON "chat_sessions" USING btree ("owner_id","agent_id");--> statement-breakpoint
CREATE INDEX "messages_owner_id_idx" ON "messages" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "messages_session_created_idx" ON "messages" USING btree ("session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_run_id_idx" ON "messages" USING btree ("run_id");