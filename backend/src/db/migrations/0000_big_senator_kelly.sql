CREATE TYPE "public"."booking_status" AS ENUM('pending', 'accepted', 'en_route', 'working', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'worker', 'admin');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('offline', 'available', 'busy', 'suspended');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"worker_service_id" integer NOT NULL,
	"status" "booking_status" NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone_number" varchar(20) NOT NULL,
	"full_name" varchar(100) NOT NULL,
	"email" varchar(255),
	"role" "user_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "worker_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bio" text,
	"average_rating" real DEFAULT 0,
	"completed_jobs" integer DEFAULT 0,
	"status" "worker_status" DEFAULT 'offline' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "worker_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "worker_profiles_rating_check" CHECK ("worker_profiles"."average_rating" >= 0 AND "worker_profiles"."average_rating" <= 5),
	CONSTRAINT "worker_profiles_jobs_check" CHECK ("worker_profiles"."completed_jobs" >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"base_price" numeric(10, 2) NOT NULL,
	"estimated_duration_minutes" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_categories_base_price_check" CHECK ("service_categories"."base_price" >= 0),
	CONSTRAINT "service_categories_duration_minutes_check" CHECK ("service_categories"."estimated_duration_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "worker_services" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_id" integer NOT NULL,
	"service_category_id" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bookings_customer_id_idx" ON "bookings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_scheduled_at_idx" ON "bookings" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "worker_profiles_status_idx" ON "worker_profiles" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_service_unique" ON "worker_services" USING btree ("worker_id","service_category_id");--> statement-breakpoint
CREATE INDEX "worker_services_worker_idx" ON "worker_services" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_services_service_idx" ON "worker_services" USING btree ("service_category_id");