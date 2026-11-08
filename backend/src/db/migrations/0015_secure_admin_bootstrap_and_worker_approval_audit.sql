CREATE TABLE "admin_bootstrap_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" integer,
	CONSTRAINT "admin_bootstrap_state_singleton_check" CHECK ("admin_bootstrap_state"."id" = 1),
	CONSTRAINT "admin_bootstrap_state_completion_check" CHECK (("admin_bootstrap_state"."completed_at" IS NULL AND "admin_bootstrap_state"."completed_by" IS NULL) OR "admin_bootstrap_state"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO "admin_bootstrap_state" ("id") VALUES (1);
--> statement-breakpoint
CREATE TABLE "worker_approval_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_profile_id" integer NOT NULL,
	"previous_status" "worker_approval_status" NOT NULL,
	"new_status" "worker_approval_status" NOT NULL,
	"actor_user_id" integer NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" varchar(500),
	CONSTRAINT "worker_approval_audit_transition_check" CHECK ("worker_approval_audit_events"."previous_status" <> "worker_approval_audit_events"."new_status" AND "worker_approval_audit_events"."new_status" <> 'pending')
);
--> statement-breakpoint
ALTER TABLE "admin_bootstrap_state" ADD CONSTRAINT "admin_bootstrap_state_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_approval_audit_worker_time_idx" ON "worker_approval_audit_events" USING btree ("worker_profile_id","decided_at");--> statement-breakpoint
CREATE INDEX "worker_approval_audit_actor_time_idx" ON "worker_approval_audit_events" USING btree ("actor_user_id","decided_at");