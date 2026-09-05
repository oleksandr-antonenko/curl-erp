CREATE TABLE "channel_drift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"expected" text,
	"actual" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_inbox_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"parked_reason" text,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"counterparty_id" uuid,
	"payload" jsonb NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"entity_type" text NOT NULL,
	"local_id" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_outbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"variant_local_id" text NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"price_shown" boolean DEFAULT true NOT NULL,
	"orderable" boolean DEFAULT true NOT NULL,
	"price_list" text,
	"stock_buffer" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_state" (
	"channel" text PRIMARY KEY NOT NULL,
	"last_order_fetch_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"customer_group" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counterparty_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "counterparty_identities" ADD CONSTRAINT "counterparty_identities_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_drift_open_idx" ON "channel_drift" USING btree ("channel","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_inbox_orders_key" ON "channel_inbox_orders" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "channel_inbox_orders_state_idx" ON "channel_inbox_orders" USING btree ("channel","state");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_mappings_local_key" ON "channel_mappings" USING btree ("channel","entity_type","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_mappings_external_key" ON "channel_mappings" USING btree ("channel","entity_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_outbound_subject_key" ON "channel_outbound" USING btree ("channel","kind","subject");--> statement-breakpoint
CREATE INDEX "channel_outbound_ready_idx" ON "channel_outbound" USING btree ("channel","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_publications_key" ON "channel_publications" USING btree ("channel","variant_local_id");--> statement-breakpoint
CREATE INDEX "channel_publications_listed_idx" ON "channel_publications" USING btree ("channel","listed");--> statement-breakpoint
CREATE INDEX "counterparties_email_idx" ON "counterparties" USING btree ("email");--> statement-breakpoint
CREATE INDEX "counterparties_phone_idx" ON "counterparties" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_identities_key" ON "counterparty_identities" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "counterparty_identities_party_idx" ON "counterparty_identities" USING btree ("counterparty_id");