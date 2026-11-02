CREATE TABLE "teach_recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"timezone" text NOT NULL,
	"narration" boolean DEFAULT false NOT NULL,
	"narration_status" text DEFAULT 'off' NOT NULL,
	"narration_segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest" jsonb,
	"active_ms" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teach_recordings_state_check" CHECK ("teach_recordings"."state" in ('recording', 'paused', 'finalizing', 'complete', 'aborted', 'failed', 'discarded')),
	CONSTRAINT "teach_recordings_narration_status_check" CHECK ("teach_recordings"."narration_status" in ('off', 'pending', 'working', 'complete', 'error', 'uncertain')),
	CONSTRAINT "teach_recordings_bounds_check" CHECK ("teach_recordings"."active_ms" between 0 and 120000 and "teach_recordings"."event_count" between 0 and 300)
);
--> statement-breakpoint
ALTER TABLE "cost_entries" DROP CONSTRAINT "cost_entries_idempotency_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_type_check";--> statement-breakpoint
ALTER TABLE "model_prices" DROP CONSTRAINT "model_prices_rates_check";--> statement-breakpoint
ALTER TABLE "cost_entries" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD COLUMN "capture_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD COLUMN "audio_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_prices" ADD COLUMN "audio_micro_usd_per_hour" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "teach_recordings_owner_id_idx" ON "teach_recordings" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "teach_recordings_agent_id_idx" ON "teach_recordings" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teach_recordings_active_agent_idx" ON "teach_recordings" USING btree ("owner_id","agent_id") WHERE "teach_recordings"."state" in ('recording', 'paused', 'finalizing');--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_capture_id_teach_recordings_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."teach_recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_entries_capture_call_idx" ON "cost_entries" USING btree ("capture_id","call_index");--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_source_check" CHECK (("cost_entries"."run_id" is not null)::integer + ("cost_entries"."capture_id" is not null)::integer = 1);--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_audio_duration_check" CHECK ("cost_entries"."audio_duration_ms" between 0 and 120000);--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_idempotency_check" CHECK (("cost_entries"."run_id" is not null and "cost_entries"."idempotency_key" = 'cost:' || "cost_entries"."run_id"::text || ':' || "cost_entries"."call_index"::text) or ("cost_entries"."capture_id" is not null and "cost_entries"."idempotency_key" = 'teach:' || "cost_entries"."capture_id"::text || ':asr:' || ("cost_entries"."call_index" - 1)::text));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" in ('message', 'clarification', 'tool_connection', 'routine', 'file', 'budget_warning', 'budget_paused', 'teach_paused'));--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_rates_check" CHECK ("model_prices"."input_micro_usd_per_million" between 0 and 1000000000 and "model_prices"."cached_micro_usd_per_million" between 0 and 1000000000 and "model_prices"."output_micro_usd_per_million" between 0 and 1000000000 and "model_prices"."image_micro_usd_per_thousand" between 0 and 1000000000 and "model_prices"."audio_micro_usd_per_hour" between 0 and 1000000000);