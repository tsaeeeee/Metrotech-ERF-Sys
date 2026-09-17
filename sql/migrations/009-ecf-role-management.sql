BEGIN;

-- Existing Requestors become ECF Requestors by default. This is intentionally
-- generic: the Admin can later promote exactly one of them to ECF Checker.
INSERT INTO employee_form_roles(employee_email,form_type,role_code,active)
SELECT e.email,'ECF','REQUESTOR',true
FROM employees e
WHERE e.role='REQUESTOR'
  AND e.active=true
ON CONFLICT (employee_email,form_type) DO NOTHING;

-- Admin-facing read model. Reviewer and Approver are inherited from the
-- existing ERF primary role; only Requestor/Checker are form-specific.
CREATE OR REPLACE VIEW admin_ecf_roles AS
SELECT
  e.email,
  e.name,
  e.employee_id,
  e.department,
  e.location,
  e.division,
  e.role AS primary_role,
  e.active,
  CASE
    WHEN e.role='REVIEWER' THEN 'REVIEWER'
    WHEN e.role='APPROVER' THEN 'APPROVER'
    WHEN e.role='REQUESTOR' THEN COALESCE(fr.role_code,'NONE')
    ELSE 'NONE'
  END AS ecf_role,
  (e.role IN ('REVIEWER','APPROVER')) AS ecf_role_inherited
FROM employees e
LEFT JOIN employee_form_roles fr
  ON lower(fr.employee_email)=lower(e.email)
 AND fr.form_type='ECF'
 AND fr.active=true
WHERE e.role<>'ADMIN';

-- Central role assignment primitive for the application layer. No employee
-- name is hardcoded. Only users whose primary role is REQUESTOR can receive
-- the form-specific REQUESTOR/CHECKER roles. REVIEWER and APPROVER stay
-- inherited from the existing ERF role.
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
      MESSAGE='Reviewer and Approver ECF access is inherited from the primary role.';
  END IF;

  IF target.role<>'REQUESTOR' THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='Only employees with primary role Requestor can be assigned ECF Requestor or Checker access.';
  END IF;

  IF normalized_role NOT IN ('REQUESTOR','CHECKER','NONE') THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',
      MESSAGE='ECF role must be Requestor, Checker, or None.';
  END IF;

  IF normalized_role='NONE' THEN
    DELETE FROM employee_form_roles
    WHERE lower(employee_email)=lower(target.email)
      AND form_type='ECF';

    RETURN QUERY SELECT target.email::text,'NONE'::text;
    RETURN;
  END IF;

  IF normalized_role='CHECKER' THEN
    SELECT fr.employee_email,e.name
      INTO current_checker
    FROM employee_form_roles fr
    JOIN employees e ON lower(e.email)=lower(fr.employee_email)
    WHERE fr.form_type='ECF'
      AND fr.role_code='CHECKER'
      AND fr.active=true
      AND lower(fr.employee_email)<>lower(target.email)
    LIMIT 1;

    IF FOUND AND NOT p_replace_checker THEN
      RAISE EXCEPTION USING
        ERRCODE='P0001',
        MESSAGE=format('ECF Checker is currently assigned to %s. Confirm replacement first.',current_checker.name);
    END IF;

    IF FOUND AND p_replace_checker THEN
      DELETE FROM employee_form_roles
      WHERE form_type='ECF'
        AND role_code='CHECKER'
        AND active=true
        AND lower(employee_email)<>lower(target.email);
    END IF;
  END IF;

  INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
  VALUES(target.email,'ECF',normalized_role,true,now())
  ON CONFLICT (employee_email,form_type) DO UPDATE
  SET role_code=excluded.role_code,
      active=true,
      updated_at=now();

  RETURN QUERY SELECT target.email::text,normalized_role::text;
END;
$$;

COMMIT;
