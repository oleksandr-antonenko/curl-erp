CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"reference" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"note" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"line_total_minor" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_withdrawn_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_order_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"channel_order_id" text NOT NULL,
	"contractor_id" uuid NOT NULL,
	"payment_method" text,
	"suggested_entity_id" uuid,
	"legal_entity_id" uuid,
	"entity_confirmed_by_type" text,
	"entity_confirmed_by_id" text,
	"entity_confirmed_at" timestamp with time zone,
	"number" integer,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"items_minor" bigint NOT NULL,
	"shipping_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"delivery" jsonb,
	"delivery_note" text,
	"tracking_reference" text,
	"placed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_withdrawn_numbers" ADD CONSTRAINT "sales_order_withdrawn_numbers_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_withdrawn_numbers" ADD CONSTRAINT "sales_order_withdrawn_numbers_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_inbox_order_id_channel_inbox_orders_id_fk" FOREIGN KEY ("inbox_order_id") REFERENCES "public"."channel_inbox_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_suggested_entity_id_legal_entities_id_fk" FOREIGN KEY ("suggested_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_source_reference_key" ON "payments" USING btree ("source","reference");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "sales_order_events_order_idx" ON "sales_order_events" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_lines_position_key" ON "sales_order_lines" USING btree ("order_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_withdrawn_numbers_key" ON "sales_order_withdrawn_numbers" USING btree ("legal_entity_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_inbox_key" ON "sales_orders" USING btree ("inbox_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_entity_number_key" ON "sales_orders" USING btree ("legal_entity_id","number");--> statement-breakpoint
CREATE INDEX "sales_orders_status_idx" ON "sales_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sales_orders_contractor_idx" ON "sales_orders" USING btree ("contractor_id");