CREATE TABLE "channel_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"external_order_id" text NOT NULL,
	"reference" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_payments_reference_key" ON "channel_payments" USING btree ("channel","reference");--> statement-breakpoint
CREATE INDEX "channel_payments_order_idx" ON "channel_payments" USING btree ("channel","external_order_id");