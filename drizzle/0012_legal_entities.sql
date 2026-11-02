CREATE TABLE "document_sequences" (
	"legal_entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"next_value" integer NOT NULL,
	CONSTRAINT "document_sequences_legal_entity_id_kind_pk" PRIMARY KEY("legal_entity_id","kind")
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"registry_code" text NOT NULL,
	"iban" text,
	"bank_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entity_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entity_payment_defaults" (
	"payment_method" text PRIMARY KEY NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entity_changes" ADD CONSTRAINT "legal_entity_changes_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entity_payment_defaults" ADD CONSTRAINT "legal_entity_payment_defaults_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_registry_code_key" ON "legal_entities" USING btree ("registry_code");--> statement-breakpoint
CREATE INDEX "legal_entity_changes_entity_idx" ON "legal_entity_changes" USING btree ("legal_entity_id","changed_at");