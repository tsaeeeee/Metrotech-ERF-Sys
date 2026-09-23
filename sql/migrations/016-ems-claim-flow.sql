BEGIN;

ALTER TABLE daily_counters DROP CONSTRAINT IF EXISTS daily_counters_request_type_check;
ALTER TABLE daily_counters ADD CONSTRAINT daily_counters_request_type_check
  CHECK (request_type IN ('EXPENSE','REIMBURSEMENT','ECF'));

-- Preserve an explicitly assigned Checker when employee details are edited.
CREATE OR REPLACE FUNCTION sync_employee_ecf_role()
RETURNS trigger LANGUAGE plpgsql AS $$
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
  ELSIF NEW.role<>'REQUESTOR' OR NEW.active=false THEN
    DELETE FROM employee_form_roles
    WHERE lower(employee_email)=lower(NEW.email) AND form_type='ECF';
  END IF;
  RETURN NEW;
END;
$$;

-- Normalize legacy rows: a CHECKER also needs the basic Requestor grant.
INSERT INTO employee_form_roles(employee_email,form_type,role_code,active)
SELECT employee_email,'ECF','REQUESTOR',true
FROM employee_form_roles WHERE form_type='ECF' AND role_code='CHECKER'
ON CONFLICT(employee_email,form_type,role_code) DO UPDATE SET active=true;

CREATE INDEX IF NOT EXISTS requests_form_status_date_idx
  ON requests(form_type,status,request_date);

COMMIT;
