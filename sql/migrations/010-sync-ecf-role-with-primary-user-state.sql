BEGIN;

-- Keep ECF access aligned with the existing primary user state without
-- changing the ERF role model. Requestors get ECF Requestor access by default;
-- Reviewer/Approver access is inherited and therefore does not need a row in
-- employee_form_roles.
CREATE OR REPLACE FUNCTION sync_employee_ecf_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role='REQUESTOR' AND NEW.active=true THEN
    INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
    VALUES(NEW.email,'ECF','REQUESTOR',true,now())
    ON CONFLICT (employee_email,form_type) DO UPDATE
    SET role_code=CASE
          WHEN OLD.role='REQUESTOR' AND OLD.active=true
            THEN employee_form_roles.role_code
          ELSE 'REQUESTOR'
        END,
        active=true,
        updated_at=now();
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

-- Normalize any current inactive/non-requestor leftovers, then make sure all
-- active Requestors have a form-specific ECF access row.
DELETE FROM employee_form_roles fr
USING employees e
WHERE lower(fr.employee_email)=lower(e.email)
  AND fr.form_type='ECF'
  AND (e.role<>'REQUESTOR' OR e.active=false);

INSERT INTO employee_form_roles(employee_email,form_type,role_code,active)
SELECT e.email,'ECF','REQUESTOR',true
FROM employees e
WHERE e.role='REQUESTOR'
  AND e.active=true
ON CONFLICT (employee_email,form_type) DO NOTHING;

COMMIT;
