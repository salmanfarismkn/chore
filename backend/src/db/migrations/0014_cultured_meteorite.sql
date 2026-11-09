CREATE TYPE "public"."worker_approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "approval_status" "worker_approval_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "approval_decided_by" integer;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "approval_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_approval_decided_by_users_id_fk" FOREIGN KEY ("approval_decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_profiles_approval_status_idx" ON "worker_profiles" USING btree ("approval_status");--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_approval_decision_check" CHECK (("worker_profiles"."approval_status" = 'pending' AND "worker_profiles"."approval_decided_by" IS NULL AND "worker_profiles"."approval_decided_at" IS NULL) OR ("worker_profiles"."approval_status" <> 'pending' AND "worker_profiles"."approval_decided_at" IS NOT NULL));