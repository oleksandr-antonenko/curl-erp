ALTER TABLE "channel_inbox_orders" ADD COLUMN "shipping_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_inbox_orders" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "channel_inbox_orders" ADD COLUMN "suggested_counterparty_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_inbox_orders" ADD CONSTRAINT "channel_inbox_orders_suggested_counterparty_id_contractors_id_fk" FOREIGN KEY ("suggested_counterparty_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;