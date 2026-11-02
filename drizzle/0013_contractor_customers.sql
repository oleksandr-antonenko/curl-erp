CREATE TABLE "contractor_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"recipient_name" text,
	"phone" text,
	"city" text,
	"address_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contractor_legacy_ids" (
	"source" text NOT NULL,
	"legacy_id" text NOT NULL,
	"contractor_id" uuid NOT NULL,
	"address_id" uuid,
	CONSTRAINT "contractor_legacy_ids_source_legacy_id_pk" PRIMARY KEY("source","legacy_id")
);
--> statement-breakpoint
ALTER TABLE "contractors" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contractors" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "contractors" ADD COLUMN "customer_group" text;--> statement-breakpoint
ALTER TABLE "contractors" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "contractor_addresses" ADD CONSTRAINT "contractor_addresses_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_legacy_ids" ADD CONSTRAINT "contractor_legacy_ids_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_legacy_ids" ADD CONSTRAINT "contractor_legacy_ids_address_id_contractor_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."contractor_addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contractor_addresses_contractor_idx" ON "contractor_addresses" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "contractor_legacy_ids_contractor_idx" ON "contractor_legacy_ids" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "contractors_email_idx" ON "contractors" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contractors_phone_idx" ON "contractors" USING btree ("phone");