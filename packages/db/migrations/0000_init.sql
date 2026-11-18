-- pg_trgm：去重 trigram 比對與 title_normalized / venue.name GIN 索引所需（tech-spec §2）。
-- 手動加入；drizzle-kit 不產生 extension 語句。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TYPE "public"."crawl_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."crawl_schedule" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('pending_review', 'published', 'hidden', 'cancelled', 'ended');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('concert', 'fan_meeting', 'exhibition', 'popup_cafe', 'doujin', 'expo', 'other');--> statement-breakpoint
CREATE TYPE "public"."region" AS ENUM('north', 'central', 'south', 'east', 'islands', 'online');--> statement-breakpoint
CREATE TYPE "public"."review_reason" AS ENUM('missing_date', 'ambiguous_date', 'missing_venue', 'unknown_venue', 'outside_taiwan', 'possible_duplicate', 'type_unresolved', 'below_scale_threshold', 'parse_error', 'source_changed');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('agency', 'ticketing', 'doujin', 'expo');--> statement-breakpoint
CREATE TYPE "public"."tag_kind" AS ENUM('work', 'agency', 'voice_actor', 'artist');--> statement-breakpoint
CREATE TYPE "public"."tag_origin" AS ENUM('source', 'dict', 'manual');--> statement-breakpoint
CREATE TABLE "city" (
	"name" text PRIMARY KEY NOT NULL,
	"region" "region" NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "tag_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_kind_slug_uq" UNIQUE("kind","slug")
);
--> statement-breakpoint
CREATE TABLE "type_keyword" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" "event_type" NOT NULL,
	"keyword" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"city" text NOT NULL,
	"region" "region" NOT NULL,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "crawl_run" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "crawl_run_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "crawl_run_status" DEFAULT 'running' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"items_found" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_pending_review" integer DEFAULT 0 NOT NULL,
	"items_skipped" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "raw_snapshot" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "raw_snapshot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" text NOT NULL,
	"crawl_run_id" bigint,
	"url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"content_type" text,
	"content_hash" text NOT NULL,
	"storage_path" text NOT NULL,
	"encoding" text
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"base_url" text,
	"schedule" "crawl_schedule" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_success_at" timestamp with time zone,
	"consecutive_empty_runs" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_item" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_item_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"content_hash" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"event_id" bigint,
	"last_snapshot_id" bigint,
	"skip_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_item_source_external_uq" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"title_normalized" text NOT NULL,
	"type" "event_type",
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"year_inferred" boolean DEFAULT false NOT NULL,
	"venue_id" integer,
	"venue_raw" text,
	"is_online" boolean DEFAULT false NOT NULL,
	"city" text,
	"region" "region",
	"price_min" integer,
	"price_max" integer,
	"is_free" boolean DEFAULT false NOT NULL,
	"sale_start_at" timestamp with time zone,
	"status" "event_status" DEFAULT 'pending_review' NOT NULL,
	"review_reasons" "review_reason"[] DEFAULT '{}' NOT NULL,
	"locked_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "event_end_after_start" CHECK ("event"."end_at" IS NULL OR "event"."start_at" IS NULL OR "event"."end_at" >= "event"."start_at"),
	CONSTRAINT "event_price_nonnegative" CHECK (("event"."price_min" IS NULL OR "event"."price_min" >= 0) AND ("event"."price_max" IS NULL OR "event"."price_max" >= 0)),
	CONSTRAINT "event_price_range" CHECK ("event"."price_min" IS NULL OR "event"."price_max" IS NULL OR "event"."price_min" <= "event"."price_max"),
	CONSTRAINT "event_online_region" CHECK (("event"."is_online" AND ("event"."region" IS NULL OR "event"."region" = 'online')) OR (NOT "event"."is_online" AND ("event"."region" IS NULL OR "event"."region" <> 'online'))),
	CONSTRAINT "event_published_requirements" CHECK ("event"."status" <> 'published' OR ("event"."start_at" IS NOT NULL AND "event"."type" IS NOT NULL AND ("event"."venue_id" IS NOT NULL OR "event"."is_online") AND cardinality("event"."review_reasons") = 0 AND "event"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "event_source" (
	"event_id" bigint NOT NULL,
	"source_item_id" bigint NOT NULL,
	"url" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_source_event_id_source_item_id_pk" PRIMARY KEY("event_id","source_item_id"),
	CONSTRAINT "event_source_source_item_uq" UNIQUE("source_item_id")
);
--> statement-breakpoint
CREATE TABLE "event_tag" (
	"event_id" bigint NOT NULL,
	"tag_id" integer NOT NULL,
	"origin" "tag_origin" NOT NULL,
	"matched_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_tag_event_id_tag_id_pk" PRIMARY KEY("event_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"diff" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venue" ADD CONSTRAINT "venue_city_city_name_fk" FOREIGN KEY ("city") REFERENCES "public"."city"("name") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "crawl_run" ADD CONSTRAINT "crawl_run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshot" ADD CONSTRAINT "raw_snapshot_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshot" ADD CONSTRAINT "raw_snapshot_crawl_run_id_crawl_run_id_fk" FOREIGN KEY ("crawl_run_id") REFERENCES "public"."crawl_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item" ADD CONSTRAINT "source_item_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item" ADD CONSTRAINT "source_item_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item" ADD CONSTRAINT "source_item_last_snapshot_id_raw_snapshot_id_fk" FOREIGN KEY ("last_snapshot_id") REFERENCES "public"."raw_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_venue_id_venue_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_city_city_name_fk" FOREIGN KEY ("city") REFERENCES "public"."city"("name") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "event_source" ADD CONSTRAINT "event_source_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_source" ADD CONSTRAINT "event_source_source_item_id_source_item_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tag" ADD CONSTRAINT "event_tag_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tag" ADD CONSTRAINT "event_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_aliases_gin_idx" ON "tag" USING gin ("aliases");--> statement-breakpoint
CREATE UNIQUE INDEX "type_keyword_keyword_uq" ON "type_keyword" USING btree (lower("keyword"));--> statement-breakpoint
CREATE INDEX "venue_aliases_gin_idx" ON "venue" USING gin ("aliases");--> statement-breakpoint
CREATE INDEX "venue_name_trgm_idx" ON "venue" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "crawl_run_source_started_idx" ON "crawl_run" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "raw_snapshot_source_fetched_idx" ON "raw_snapshot" USING btree ("source_id","fetched_at");--> statement-breakpoint
CREATE INDEX "raw_snapshot_fetched_idx" ON "raw_snapshot" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "source_item_event_idx" ON "source_item" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_title_normalized_trgm_idx" ON "event" USING gin ("title_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "event_status_start_idx" ON "event" USING btree ("status","start_at");--> statement-breakpoint
CREATE INDEX "event_start_idx" ON "event" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "event_venue_idx" ON "event" USING btree ("venue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_source_one_primary_uq" ON "event_source" USING btree ("event_id") WHERE "event_source"."is_primary";--> statement-breakpoint
CREATE INDEX "event_tag_tag_idx" ON "event_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id","at");