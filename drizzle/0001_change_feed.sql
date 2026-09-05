CREATE TABLE "change_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"xact_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text,
	"actor_id" text,
	"actor_conversation_id" text,
	"changed_fields" jsonb
);
--> statement-breakpoint
CREATE TABLE "feed_consumers" (
	"name" text PRIMARY KEY NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feed_failures" (
	"consumer" text NOT NULL,
	"event_id" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parked_at" timestamp with time zone,
	CONSTRAINT "feed_failures_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE INDEX "change_events_entity_idx" ON "change_events" USING btree ("entity_type","entity_id","id");--> statement-breakpoint
CREATE INDEX "change_events_xact_idx" ON "change_events" USING btree ("xact_id");--> statement-breakpoint
CREATE INDEX "feed_failures_parked_idx" ON "feed_failures" USING btree ("consumer","parked_at");