CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'simulated', 'failed', 'gone');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('new_event', 'new_event_digest', 'sale_reminder', 'event_reminder', 'test');--> statement-breakpoint
CREATE TYPE "public"."notify_channel" AS ENUM('web_push', 'line');--> statement-breakpoint
CREATE TABLE "favorite" (
	"subscriber_id" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorite_subscriber_id_event_id_pk" PRIMARY KEY("subscriber_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subscriber_id" bigint NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"event_id" bigint,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_delivery_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notification_id" bigint NOT NULL,
	"channel" "notify_channel" NOT NULL,
	"target" text NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_target_uq" UNIQUE("notification_id","channel","target")
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "push_subscription_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subscriber_id" bigint NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "subscriber" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscriber_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_hash" text NOT NULL,
	"notify_new_event" boolean DEFAULT true NOT NULL,
	"notify_sale_reminder" boolean DEFAULT true NOT NULL,
	"notify_event_reminder" boolean DEFAULT true NOT NULL,
	"line_user_id" text,
	"line_linked_at" timestamp with time zone,
	"line_link_code" text,
	"line_link_code_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriber_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "subscriber_line_user_id_unique" UNIQUE("line_user_id"),
	CONSTRAINT "subscriber_line_link_code_unique" UNIQUE("line_link_code")
);
--> statement-breakpoint
CREATE TABLE "tag_follow" (
	"subscriber_id" bigint NOT NULL,
	"tag_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_follow_subscriber_id_tag_id_pk" PRIMARY KEY("subscriber_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "type_follow" (
	"subscriber_id" bigint NOT NULL,
	"event_type" "event_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "type_follow_subscriber_id_event_type_pk" PRIMARY KEY("subscriber_id","event_type")
);
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "new_event_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_follow" ADD CONSTRAINT "tag_follow_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_follow" ADD CONSTRAINT "tag_follow_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_follow" ADD CONSTRAINT "type_follow_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "favorite_event_idx" ON "favorite" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "notification_subscriber_idx" ON "notification" USING btree ("subscriber_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_pending_idx" ON "notification_delivery" USING btree ("not_before") WHERE "notification_delivery"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "push_subscription_subscriber_idx" ON "push_subscription" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "tag_follow_tag_idx" ON "tag_follow" USING btree ("tag_id");--> statement-breakpoint
-- 手動加入：既有已發布／已結束活動視為「已通知」，避免第一次部署時對舊活動大量推播
UPDATE "event" SET "new_event_notified_at" = now() WHERE "status" IN ('published', 'ended');
