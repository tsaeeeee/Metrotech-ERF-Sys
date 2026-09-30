BEGIN;

-- The RETURNS TABLE output column `employee_email` is a PL/pgSQL variable.
-- Using ON CONFLICT(employee_email, form_type) therefore remains ambiguous
-- even when all WHERE clauses are qualified. Target the PK constraint instead.
CREATE OR REPLACE FUNCTION set_ecf_employee_role(
  p_email text,
  p_role text,
  p_replace_checker boolean DEFAULT false
)
RETURNS TABLE(employee_email text, ecf_role text)
LANGUAGE plpgsql
AS $$
DECLARE
  target employees%ROWTYPE;
  normalized_role text := upper(btrim(coalesce(p_role,'')));
  current_checker record;
BEGIN
  PERFORM pg_advisory_xact_lock(77123003);

  SELECT * INTO target
  FROM employees
  WHERE lower(email)=lower(p_email)
    AND role<>'ADMIN'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Employee not found.';
  END IF;

  IF target.role IN ('REVIEWER','APPROVER') THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='Reviewer and Approver ECF access is inherited from ERF Access.';
  END IF;

  IF target.role<>'REQUESTOR' THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='Only employees with ERF Access Requestor can be assigned ECF Requestor or Checker access.';
  END IF;

  IF normalized_role NOT IN ('REQUESTOR','CHECKER','NONE') THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',
      MESSAGE='ECF access must be Requestor, Checker, or None.';
  END IF;

  IF normalized_role='NONE' THEN
    DELETE FROM employee_form_roles AS fr
    WHERE lower(fr.employee_email)=lower(target.email)
      AND fr.form_type='ECF';

    RETURN QUERY SELECT target.email::text,'NONE'::text;
    RETURN;
  END IF;

  IF target.active=false THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='Inactive users cannot receive active ECF access.';
  END IF;

  IF normalized_role='CHECKER' THEN
    SELECT fr.employee_email,e.name
      INTO current_checker
    FROM employee_form_roles AS fr
    JOIN employees AS e ON lower(e.email)=lower(fr.employee_email)
    WHERE fr.form_type='ECF'
      AND fr.role_code='CHECKER'
      AND fr.active=true
      AND e.active=true
      AND lower(fr.employee_email)<>lower(target.email)
    LIMIT 1;

    IF FOUND AND NOT p_replace_checker THEN
      RAISE EXCEPTION USING
        ERRCODE='P0001',
        MESSAGE=format('ECF Checker is currently assigned to %s. Confirm replacement first.',current_checker.name);
    END IF;

    IF FOUND AND p_replace_checker THEN
      DELETE FROM employee_form_roles AS fr
      WHERE fr.form_type='ECF'
        AND fr.role_code='CHECKER'
        AND fr.active=true
        AND lower(fr.employee_email)<>lower(target.email);
    END IF;
  END IF;

  INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
  VALUES(target.email,'ECF',normalized_role,true,now())
  ON CONFLICT ON CONSTRAINT employee_form_roles_pkey DO UPDATE
  SET role_code=excluded.role_code,
      active=true,
      updated_at=now();

  RETURN QUERY SELECT target.email::text,normalized_role::text;
END;
$$;

COMMIT;
