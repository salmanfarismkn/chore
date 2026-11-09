CREATE TYPE "public"."app_session_client_type" AS ENUM('web', 'native');--> statement-breakpoint
CREATE TABLE "app_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"client_type" "app_session_client_type" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"csrf_token_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_sessions_token_hash_unique" ON "app_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "app_sessions_user_id_idx" ON "app_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_sessions_expires_at_idx" ON "app_sessions" USING btree ("expires_at");