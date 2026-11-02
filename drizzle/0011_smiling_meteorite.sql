CREATE TABLE "cost_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"call_index" integer NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"tokens_cached" integer NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"outcome" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_entries_call_index_check" CHECK ("cost_entries"."call_index" > 0),
	CONSTRAINT "cost_entries_tokens_check" CHECK ("cost_entries"."tokens_in" >= 0 and "cost_entries"."tokens_out" >= 0 and "cost_entries"."tokens_cached" >= 0 and "cost_entries"."tokens_cached" <= "cost_entries"."tokens_in"),
	CONSTRAINT "cost_entries_cost_check" CHECK ("cost_entries"."cost_micro_usd" >= 0),
	CONSTRAINT "cost_entries_outcome_check" CHECK ("cost_entries"."outcome" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "cost_entries_idempotency_check" CHECK ("cost_entries"."idempotency_key" = 'cost:' || "cost_entries"."run_id"::text || ':' || "cost_entries"."call_index"::text)
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_micro_usd_per_million" bigint DEFAULT 0 NOT NULL,
	"cached_micro_usd_per_million" bigint DEFAULT 0 NOT NULL,
	"output_micro_usd_per_million" bigint DEFAULT 0 NOT NULL,
	"image_micro_usd_per_thousand" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_model_check" CHECK ("model_prices"."model" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
	CONSTRAINT "model_prices_rates_check" CHECK ("model_prices"."input_micro_usd_per_million" between 0 and 1000000000 and "model_prices"."cached_micro_usd_per_million" between 0 and 1000000000 and "model_prices"."output_micro_usd_per_million" between 0 and 1000000000 and "model_prices"."image_micro_usd_per_thousand" between 0 and 1000000000)
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_type_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "attention_reason" text;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_entries_owner_id_idx" ON "cost_entries" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "cost_entries_run_id_idx" ON "cost_entries" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_entries_run_call_idx" ON "cost_entries" USING btree ("run_id","call_index");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_entries_idempotency_key_idx" ON "cost_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "model_prices_owner_id_idx" ON "model_prices" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "model_prices_provider_id_idx" ON "model_prices" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_prices_owner_provider_model_idx" ON "model_prices" USING btree ("owner_id","provider_id","model");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_attention_reason_check" CHECK ("agents"."attention_reason" is null or "agents"."attention_reason" in ('budget_warning', 'budget_paused'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused'));