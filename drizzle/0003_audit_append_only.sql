-- The audit log is append-only at the database, not only in the application.
-- An application that can rewrite its own audit log proves nothing about the
-- application, so the guarantee is put where the application cannot reach it.
CREATE OR REPLACE FUNCTION erp_security_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'security_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER security_events_no_update
  BEFORE UPDATE ON security_events
  FOR EACH ROW EXECUTE FUNCTION erp_security_events_append_only();
--> statement-breakpoint
CREATE TRIGGER security_events_no_delete
  BEFORE DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION erp_security_events_append_only();
