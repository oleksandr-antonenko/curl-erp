-- Customers move into the contractor registry. Ids are kept, so every identity
-- link and every inbox order still points at the same customer afterwards.
INSERT INTO "contractors" ("id", "name", "roles", "email", "phone", "customer_group", "actor_type", "actor_id", "created_at", "updated_at")
SELECT "id", "name", ARRAY['customer']::text[], lower(nullif(trim("email"), '')),
       nullif(regexp_replace(coalesce("phone", ''), '\D', '', 'g'), ''),
       "customer_group", 'integration', 'migration:0014_fold_counterparties', "created_at", "updated_at"
FROM "counterparties";
--> statement-breakpoint
ALTER TABLE "counterparty_identities" DROP CONSTRAINT "counterparty_identities_counterparty_id_counterparties_id_fk";
--> statement-breakpoint
DROP TABLE "counterparties";
--> statement-breakpoint
ALTER TABLE "channel_inbox_orders" ADD CONSTRAINT "channel_inbox_orders_counterparty_id_contractors_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_identities" ADD CONSTRAINT "counterparty_identities_counterparty_id_contractors_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."contractors"("id") ON DELETE restrict ON UPDATE no action;
