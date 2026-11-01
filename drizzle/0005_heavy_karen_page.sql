CREATE TABLE "model_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"role" text NOT NULL,
	"provider_id" uuid,
	"model" text,
	"use_main_key" boolean DEFAULT false NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_roles_role_check" CHECK ("model_roles"."role" in ('main', 'sam')),
	CONSTRAINT "model_roles_mode_check" CHECK ("model_roles"."mode" in ('active', 'off', 'meta')),
	CONSTRAINT "model_roles_main_shape_check" CHECK ("model_roles"."role" <> 'main' or ("model_roles"."mode" = 'active' and "model_roles"."provider_id" is not null and "model_roles"."model" is not null and "model_roles"."use_main_key" = false)),
	CONSTRAINT "model_roles_sam_shape_check" CHECK ("model_roles"."role" <> 'sam' or (("model_roles"."mode" = 'off' and "model_roles"."provider_id" is null and "model_roles"."model" is null and "model_roles"."use_main_key" = false) or ("model_roles"."mode" = 'meta' and "model_roles"."provider_id" is not null and "model_roles"."model" is not null)))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"encrypted_key" text,
	"key_hint" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_kind_check" CHECK ("providers"."kind" in ('meta', 'openai-compatible'))
);
--> statement-breakpoint
ALTER TABLE "model_roles" ADD CONSTRAINT "model_roles_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_roles_owner_id_idx" ON "model_roles" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "model_roles_provider_id_idx" ON "model_roles" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_roles_owner_role_idx" ON "model_roles" USING btree ("owner_id","role");--> statement-breakpoint
CREATE INDEX "providers_owner_id_idx" ON "providers" USING btree ("owner_id");