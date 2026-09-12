CREATE TABLE "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"registry_code" text,
	"tax_code" text,
	"roles" text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_hash" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"location" text NOT NULL,
	"file_name" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_conversation_id" text,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity_received" integer NOT NULL,
	"quantity_remaining" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'UAH' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_receipt_line_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"lot_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"raw_name" text NOT NULL,
	"unit" text,
	"quantity" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"recognised" jsonb
);
--> statement-breakpoint
CREATE TABLE "supplier_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"number" text,
	"supplier_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"document_date" timestamp with time zone,
	"stated_total_minor" bigint NOT NULL,
	"currency" text DEFAULT 'UAH' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"document_id" uuid,
	"source_note" text,
	"recognition" jsonb,
	"obligation_minor" bigint,
	"created_actor_type" text NOT NULL,
	"created_actor_id" text NOT NULL,
	"created_actor_conversation_id" text,
	"posted_actor_type" text,
	"posted_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_receipt_line_parts" ADD CONSTRAINT "supplier_receipt_line_parts_line_id_supplier_receipt_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."supplier_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_receipt_line_parts" ADD CONSTRAINT "supplier_receipt_line_parts_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_receipt_lines" ADD CONSTRAINT "supplier_receipt_lines_receipt_id_supplier_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."supplier_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_receipts" ADD CONSTRAINT "supplier_receipts_supplier_id_contractors_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_receipts" ADD CONSTRAINT "supplier_receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_receipts" ADD CONSTRAINT "supplier_receipts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contractors_registry_code_key" ON "contractors" USING btree ("registry_code");--> statement-breakpoint
CREATE UNIQUE INDEX "contractors_tax_code_key" ON "contractors" USING btree ("tax_code");--> statement-breakpoint
CREATE INDEX "contractors_name_idx" ON "contractors" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_content_hash_key" ON "documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "documents_stored_at_idx" ON "documents" USING btree ("stored_at");--> statement-breakpoint
CREATE INDEX "stock_lots_variant_idx" ON "stock_lots" USING btree ("variant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_lots_source_idx" ON "stock_lots" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "stock_lots_received_idx" ON "stock_lots" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses" USING btree ("code");--> statement-breakpoint
CREATE INDEX "supplier_receipt_line_parts_line_idx" ON "supplier_receipt_line_parts" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_receipt_lines_position_key" ON "supplier_receipt_lines" USING btree ("receipt_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_receipts_entity_number_key" ON "supplier_receipts" USING btree ("legal_entity_id","number");--> statement-breakpoint
CREATE INDEX "supplier_receipts_supplier_idx" ON "supplier_receipts" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_receipts_state_idx" ON "supplier_receipts" USING btree ("state");