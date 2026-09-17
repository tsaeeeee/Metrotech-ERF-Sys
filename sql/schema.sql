CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS employees (
  email text PRIMARY KEY,
  name text NOT NULL,
  employee_id text NOT NULL,
  department text NOT NULL,
  location text NOT NULL,
  division text NOT NULL,
  role text NOT NULL CHECK (role IN ('REQUESTOR','REVIEWER','APPROVER','ADMIN')),
  signature_file text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  username text,
  password_hash text
);

CREATE TABLE IF NOT EXISTS employee_form_roles (
  employee_email text NOT NULL REFERENCES employees(email) ON DELETE CASCADE,
  form_type text NOT NULL CHECK (form_type IN ('ECF')),
  role_code text NOT NULL CHECK (role_code IN ('REQUESTOR','CHECKER')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_email, form_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_form_roles_single_checker_uidx
  ON employee_form_roles(form_type)
  WHERE active=true AND role_code='CHECKER';

CREATE OR REPLACE FUNCTION sync_employee_ecf_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preserve_existing_role boolean := false;
BEGIN
  IF TG_OP='UPDATE' THEN
    preserve_existing_role := OLD.role='REQUESTOR' AND OLD.active=true;
  END IF;

  IF NEW.role='REQUESTOR' AND NEW.active=true THEN
    INSERT INTO employee_form_roles(employee_email,form_type,role_code,active,updated_at)
    VALUES(NEW.email,'ECF','REQUESTOR',true,now())
    ON CONFLICT (employee_email,form_type) DO UPDATE
    SET role_code=CASE
          WHEN preserve_existing_role THEN employee_form_roles.role_code
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

CREATE TABLE IF NOT EXISTS employee_payment_profiles (
  employee_email text PRIMARY KEY REFERENCES employees(email) ON DELETE CASCADE,
  payment_to text NOT NULL DEFAULT '',
  bank_name text NOT NULL DEFAULT '',
  bank_code text NOT NULL DEFAULT '',
  account_number text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no text NOT NULL UNIQUE,
  request_date date NOT NULL,
  requester_email text NOT NULL REFERENCES employees(email),
  employee_name text NOT NULL,
  employee_id text NOT NULL,
  department text NOT NULL,
  location text NOT NULL,
  division text NOT NULL,
  request_type text NOT NULL DEFAULT 'EXPENSE' CHECK (request_type IN ('EXPENSE','REIMBURSEMENT')),
  total numeric(18,2) NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_CHECK','CHECK_REJECTED','PENDING_REVIEW','RECALLED','REVIEW_REJECTED','PENDING_APPROVAL','APPROVAL_REJECTED','APPROVED')),
  revision integer NOT NULL DEFAULT 1,
  form_pdf_path text,
  evidence_pdf_path text,
  last_rejection_reason text NOT NULL DEFAULT '',
  reviewer_email text NOT NULL,
  approver_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS requests_requester_idx ON requests(requester_email);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests(status);

CREATE TABLE IF NOT EXISTS ecf_details (
  request_id uuid PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  service_order_number text NOT NULL DEFAULT '-',
  payment_to text NOT NULL,
  bank_name text NOT NULL,
  bank_code text NOT NULL,
  account_number text NOT NULL,
  checker_email text NOT NULL,
  checker_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ecf_details_checker_idx ON ecf_details(checker_email);

CREATE TABLE IF NOT EXISTS request_items (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  line_no integer NOT NULL,
  category text NOT NULL,
  purpose text NOT NULL,
  payment_date date NOT NULL,
  amount numeric(18,2) NOT NULL,
  evidence_names text[] NOT NULL DEFAULT '{}',
  UNIQUE(request_id, revision, line_no)
);

CREATE TABLE IF NOT EXISTS workflow_actions (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  ref_no text NOT NULL,
  revision integer NOT NULL,
  actor_email text NOT NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  from_status text,
  to_status text,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_actions_request_idx ON workflow_actions(request_id, created_at);

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

CREATE TABLE IF NOT EXISTS daily_counters (
  counter_date date NOT NULL,
  request_type text NOT NULL DEFAULT 'EXPENSE' CHECK (request_type IN ('EXPENSE','REIMBURSEMENT')),
  last_sequence integer NOT NULL DEFAULT 0,
  PRIMARY KEY(counter_date, request_type)
);

CREATE TABLE IF NOT EXISTS email_log (
  id bigserial PRIMARY KEY,
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  ref_no text,
  event text NOT NULL,
  mail_to text NOT NULL,
  mail_cc text NOT NULL DEFAULT '',
  status text NOT NULL,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employees_username_lower_uidx
  ON employees(lower(username))
  WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_settings(
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  is_secret boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE INDEX IF NOT EXISTS app_settings_updated_at_idx
  ON app_settings(updated_at);
