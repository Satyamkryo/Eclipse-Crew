CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"doc" text NOT NULL,
	"agent_id" uuid,
	"scope" text NOT NULL,
	"visible_to" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"trusted" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"author" text NOT NULL,
	"source_run_id" uuid,
	"source_label" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entries_doc_check" CHECK ("memory_entries"."doc" in ('user', 'memory', 'private')),
	CONSTRAINT "memory_entries_scope_check" CHECK ("memory_entries"."scope" in ('global', 'agent', 'private')),
	CONSTRAINT "memory_entries_shape_check" CHECK (("memory_entries"."doc" = 'user' and "memory_entries"."scope" = 'global' and "memory_entries"."agent_id" is null and cardinality("memory_entries"."visible_to") = 0) or ("memory_entries"."doc" = 'memory' and "memory_entries"."scope" = 'agent' and "memory_entries"."agent_id" is not null and cardinality("memory_entries"."visible_to") = 0) or ("memory_entries"."doc" = 'private' and "memory_entries"."scope" = 'private' and "memory_entries"."agent_id" is not null)),
	CONSTRAINT "memory_entries_visible_check" CHECK (cardinality("memory_entries"."visible_to") <= 10),
	CONSTRAINT "memory_entries_title_check" CHECK (char_length("memory_entries"."title") between 1 and 80),
	CONSTRAINT "memory_entries_body_check" CHECK (char_length("memory_entries"."body") between 1 and 600),
	CONSTRAINT "memory_entries_status_check" CHECK ("memory_entries"."status" in ('active', 'archived')),
	CONSTRAINT "memory_entries_author_check" CHECK ("memory_entries"."author" in ('owner', 'agent')),
	CONSTRAINT "memory_entries_source_label_check" CHECK ("memory_entries"."source_label" is null or char_length("memory_entries"."source_label") between 1 and 120),
	CONSTRAINT "memory_entries_version_check" CHECK ("memory_entries"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"doc_key" text NOT NULL,
	"seq" integer NOT NULL,
	"entry_id" uuid,
	"agent_id" uuid,
	"op" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"author" text NOT NULL,
	"author_agent_id" uuid,
	"reason" text,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_versions_seq_check" CHECK ("memory_versions"."seq" >= 1),
	CONSTRAINT "memory_versions_doc_key_check" CHECK ("memory_versions"."doc_key" = 'user' or "memory_versions"."doc_key" ~ '^agent:[0-9a-f-]{36}:(memory|private|soul)$'),
	CONSTRAINT "memory_versions_op_check" CHECK ("memory_versions"."op" in ('add', 'edit', 'remove', 'pin', 'unpin', 'soul_edit', 'undo')),
	CONSTRAINT "memory_versions_before_check" CHECK ("memory_versions"."before" is null or jsonb_typeof("memory_versions"."before") = 'object'),
	CONSTRAINT "memory_versions_after_check" CHECK ("memory_versions"."after" is null or jsonb_typeof("memory_versions"."after") = 'object'),
	CONSTRAINT "memory_versions_author_check" CHECK ("memory_versions"."author" in ('owner', 'agent')),
	CONSTRAINT "memory_versions_reason_check" CHECK ("memory_versions"."reason" is null or char_length("memory_versions"."reason") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_entries_owner_id_idx" ON "memory_entries" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "memory_entries_owner_doc_idx" ON "memory_entries" USING btree ("owner_id","doc");--> statement-breakpoint
CREATE INDEX "memory_entries_owner_agent_idx" ON "memory_entries" USING btree ("owner_id","agent_id");--> statement-breakpoint
CREATE INDEX "memory_versions_owner_id_idx" ON "memory_versions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "memory_versions_owner_doc_idx" ON "memory_versions" USING btree ("owner_id","doc_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_versions_owner_doc_seq_idx" ON "memory_versions" USING btree ("owner_id","doc_key","seq");