CREATE TABLE "owner" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_login_unique" UNIQUE("login"),
	CONSTRAINT "owner_id_matches_id" CHECK ("owner"."owner_id" = "owner"."id")
);
