DROP INDEX "worker_service_unique";--> statement-breakpoint
DROP INDEX "worker_services_service_idx";--> statement-breakpoint
ALTER TABLE "worker_services" DROP CONSTRAINT "worker_services_pkey";--> statement-breakpoint
ALTER TABLE "worker_services" ADD CONSTRAINT "worker_services_worker_id_service_category_id_pk" PRIMARY KEY("worker_id","service_category_id");--> statement-breakpoint
ALTER TABLE "worker_services" ADD CONSTRAINT "worker_services_worker_id_worker_profiles_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."worker_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_services" ADD CONSTRAINT "worker_services_service_category_id_service_categories_id_fk" FOREIGN KEY ("service_category_id") REFERENCES "public"."service_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_services_category_worker_idx" ON "worker_services" USING btree ("service_category_id","worker_id");--> statement-breakpoint
ALTER TABLE "worker_services" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "worker_services" DROP COLUMN "price";