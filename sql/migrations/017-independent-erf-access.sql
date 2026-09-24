-- Allow ECF-only accounts to hold independent Requestor or Checker access.
-- Existing employee roles and ECF assignments remain unchanged.
BEGIN;

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
  CHECK (role IN ('NONE','REQUESTOR','REVIEWER','APPROVER','ADMIN'));

CREATE OR REPLACE FUNCTION sync_employee_ecf_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE access_changed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    access_changed:=true;
  ELSE
    access_changed:=OLD.role IS DISTINCT FROM NEW.role OR OLD.active IS DISTINCT FROM NEW.active;
  END IF;
  IF NEW.role='REQUESTOR' AND NEW.active=true AND access_changed THEN
    INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
    VALUES(NEW.email,'ECF','REQUESTOR',true,now())
    ON CONFLICT (employee_email,form_type,role_code) DO UPDATE
    SET active=true,updated_at=now();
  ELSIF NEW.role NOT IN ('REQUESTOR','NONE') OR NEW.active=false THEN
    DELETE FROM employee_form_roles
    WHERE lower(employee_email)=lower(NEW.email)
      AND form_type='ECF';
  END IF;

  RETURN NEW;
END;
$$;

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
    WHEN e.role IN ('REQUESTOR','NONE') AND bool_or(fr.role_code='CHECKER' AND fr.active) THEN 'CHECKER'
    WHEN e.role IN ('REQUESTOR','NONE') AND bool_or(fr.role_code='REQUESTOR' AND fr.active) THEN 'REQUESTOR'
    ELSE 'NONE'
  END AS ecf_role,
  (e.role IN ('REVIEWER','APPROVER')) AS ecf_role_inherited
FROM employees e
LEFT JOIN employee_form_roles fr
  ON lower(fr.employee_email)=lower(e.email)
 AND fr.form_type='ECF'
WHERE e.role<>'ADMIN'
GROUP BY e.email,e.name,e.employee_id,e.department,e.location,e.division,e.role,e.active;

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

  IF target.role NOT IN ('REQUESTOR','NONE') THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='Only employees with ERF Access Requestor or No Access can receive ECF Requestor or Checker access.';
  END IF;

  IF normalized_role NOT IN ('REQUESTOR','CHECKER','NONE') THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',
      MESSAGE='ECF access must be Requestor, Checker, or No Access.';
  END IF;

  IF normalized_role='NONE' THEN
    DELETE FROM employee_form_roles fr
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

  INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
  VALUES(target.email,'ECF','REQUESTOR',true,now())
  ON CONFLICT ON CONSTRAINT employee_form_roles_pkey DO UPDATE
  SET active=true,updated_at=now();

  IF normalized_role='REQUESTOR' THEN
    DELETE FROM employee_form_roles fr
    WHERE lower(fr.employee_email)=lower(target.email)
      AND fr.form_type='ECF'
      AND fr.role_code='CHECKER';
    RETURN QUERY SELECT target.email::text,'REQUESTOR'::text;
    RETURN;
  END IF;

  SELECT fr.employee_email,e.name
    INTO current_checker
  FROM employee_form_roles fr
  JOIN employees e ON lower(e.email)=lower(fr.employee_email)
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
    DELETE FROM employee_form_roles fr
    WHERE fr.form_type='ECF'
      AND role_code='CHECKER'
      AND active=true
      AND lower(fr.employee_email)<>lower(target.email);
  END IF;

  INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
  VALUES(target.email,'ECF','CHECKER',true,now())
  ON CONFLICT ON CONSTRAINT employee_form_roles_pkey DO UPDATE
  SET active=true,updated_at=now();

  RETURN QUERY SELECT target.email::text,'CHECKER'::text;
END;
$$;

COMMIT;
