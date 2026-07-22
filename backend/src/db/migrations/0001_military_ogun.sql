DROP INDEX "worker_services_worker_category_idx";--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_services" ADD COLUMN "price" numeric(10, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_services" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "worker_services_worker_idx" ON "worker_services" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_services_service_idx" ON "worker_services" USING btree ("service_category_id");