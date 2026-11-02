CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"preset" text NOT NULL,
	"url" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"server_name" text NOT NULL,
	"server_version" text NOT NULL,
	"protocol_version" text NOT NULL,
	"tools_hash" text NOT NULL,
	"tools" jsonb NOT NULL,
	"status" text DEFAULT 'pinned' NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_key_check" CHECK ("mcp_servers"."key" ~ '^[a-z0-9-]{1,32}$'),
	CONSTRAINT "mcp_servers_preset_check" CHECK ("mcp_servers"."preset" in ('github', 'custom')),
	CONSTRAINT "mcp_servers_url_check" CHECK ("mcp_servers"."url" ~ '^https://[^[:space:]]+$' and char_length("mcp_servers"."url") <= 2048),
	CONSTRAINT "mcp_servers_status_check" CHECK ("mcp_servers"."status" in ('pinned', 'changed', 'disabled')),
	CONSTRAINT "mcp_servers_tools_hash_check" CHECK ("mcp_servers"."tools_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mcp_servers_tools_check" CHECK (jsonb_typeof("mcp_servers"."tools") = 'array' and pg_column_size("mcp_servers"."tools") <= 262144)
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_id_idx" ON "mcp_servers" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_agent_key_idx" ON "mcp_servers" USING btree ("agent_id","key");