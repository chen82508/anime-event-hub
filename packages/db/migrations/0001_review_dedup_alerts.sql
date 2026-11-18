CREATE TABLE "alert_state" (
	"key" text PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"suppressed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_run" ADD COLUMN "items_missing_fields" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "dedup_key" text;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "review_notes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "event_dedup_key_idx" ON "event" USING btree ("dedup_key");