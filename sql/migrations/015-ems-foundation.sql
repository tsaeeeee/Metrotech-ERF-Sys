BEGIN;

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS form_type text NOT NULL DEFAULT 'ERF';

ALTER TABLE requests
  DROP CONSTRAINT IF EXISTS requests_form_type_check;

ALTER TABLE requests
  ADD CONSTRAINT requests_form_type_check
  CHECK (form_type IN ('ERF','ECF'));

UPDATE requests r
SET form_type='ECF'
WHERE EXISTS (
  SELECT 1 FROM ecf_details d WHERE d.request_id=r.id
);

CREATE INDEX IF NOT EXISTS requests_form_type_idx
  ON requests(form_type);

ALTER TABLE ecf_details
  ADD COLUMN IF NOT EXISTS source_erf_id uuid REFERENCES requests(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ecf_details_source_erf_idx
  ON ecf_details(source_erf_id);

ALTER TABLE employee_form_roles
  DROP CONSTRAINT IF EXISTS employee_form_roles_pkey;

ALTER TABLE employee_form_roles
  ADD CONSTRAINT employee_form_roles_pkey
  PRIMARY KEY (employee_email,form_type,role_code);

CREATE OR REPLACE FUNCTION sync_employee_ecf_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role='REQUESTOR' AND NEW.active=true THEN
    INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
    VALUES(NEW.email,'ECF','REQUESTOR',true,now())
    ON CONFLICT (employee_email,form_type,role_code) DO UPDATE
    SET active=true,updated_at=now();
  ELSE
    DELETE FROM employee_form_roles
    WHERE lower(employee_email)=lower(NEW.email)
      AND form_type='ECF';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_sync_ecf_role ON employees;
CREATE TRIGGER employees_sync_ecf_role
AFTER INSERT OR UPDATE OF role,active ON employees
FOR EACH ROW
EXECUTE FUNCTION sync_employee_ecf_role();

INSERT INTO employee_form_roles(employee_email,form_type,role_code,active)
SELECT email,'ECF','REQUESTOR',true
FROM employees
WHERE role='REQUESTOR' AND active=true
ON CONFLICT (employee_email,form_type,role_code) DO UPDATE
SET active=true,updated_at=now();

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
    WHEN e.role='REQUESTOR' AND bool_or(fr.role_code='CHECKER' AND fr.active) THEN 'CHECKER'
    WHEN e.role='REQUESTOR' AND bool_or(fr.role_code='REQUESTOR' AND fr.active) THEN 'REQUESTOR'
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

  IF target.role<>'REQUESTOR' THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='Only employees with ERF Access Requestor can receive ECF Requestor or Checker access.';
  END IF;

  IF normalized_role NOT IN ('REQUESTOR','CHECKER','NONE') THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',
      MESSAGE='ECF access must be Requestor, Checker, or No Access.';
  END IF;

  IF normalized_role='NONE' THEN
    DELETE FROM employee_form_roles
    WHERE lower(employee_email)=lower(target.email)
      AND form_type='ECF';
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
  ON CONFLICT (employee_email,form_type,role_code) DO UPDATE
  SET active=true,updated_at=now();

  IF normalized_role='REQUESTOR' THEN
    DELETE FROM employee_form_roles
    WHERE lower(employee_email)=lower(target.email)
      AND form_type='ECF'
      AND role_code='CHECKER';
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
    DELETE FROM employee_form_roles
    WHERE form_type='ECF'
      AND role_code='CHECKER'
      AND active=true
      AND lower(employee_email)<>lower(target.email);
  END IF;

  INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
  VALUES(target.email,'ECF','CHECKER',true,now())
  ON CONFLICT (employee_email,form_type,role_code) DO UPDATE
  SET active=true,updated_at=now();

  RETURN QUERY SELECT target.email::text,'CHECKER'::text;
END;
$$;

COMMIT;
