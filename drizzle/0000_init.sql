CREATE TABLE "tenant_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_secrets_name_key" ON "tenant_secrets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tenant_secrets_updated_idx" ON "tenant_secrets" USING btree ("updated_at");