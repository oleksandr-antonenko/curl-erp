-- NOT VALID: enforced for every receipt written from now on, but not checked
-- against rows that already exist. Tenants created before the legal entity
-- registry hold receipts against an entity id nobody registered; they assign
-- those to a real entity and then run
--   ALTER TABLE supplier_receipts VALIDATE CONSTRAINT supplier_receipts_legal_entity_id_legal_entities_id_fk;
-- A plain constraint would make this migration fail on exactly those tenants.
ALTER TABLE "supplier_receipts" ADD CONSTRAINT "supplier_receipts_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
