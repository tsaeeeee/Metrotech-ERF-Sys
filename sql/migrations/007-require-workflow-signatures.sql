CREATE OR REPLACE FUNCTION enforce_workflow_actor_signature()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_signature text;
BEGIN
  SELECT signature_file
  INTO actor_signature
  FROM employees
  WHERE lower(email)=lower(NEW.actor_email)
    AND active=true
  LIMIT 1;

  IF coalesce(btrim(actor_signature),'')='' THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='Digital signature required. Upload your signature in My Profile before performing workflow actions.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_actor_signature_required ON workflow_actions;
CREATE TRIGGER workflow_actor_signature_required
BEFORE INSERT ON workflow_actions
FOR EACH ROW
EXECUTE FUNCTION enforce_workflow_actor_signature();
