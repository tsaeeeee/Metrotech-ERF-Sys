BEGIN;

-- ECF keeps the existing ERF role untouched and adds form-specific access.
CREATE TABLE IF NOT EXISTS employee_form_roles (
  employee_email text NOT NULL REFERENCES employees(email) ON DELETE CASCADE,
  form_type text NOT NULL CHECK (form_type IN ('ECF')),
  role_code text NOT NULL CHECK (role_code IN ('REQUESTOR','CHECKER')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_email, form_type)
);

-- At most one active Checker may exist for ECF. Application readiness checks
-- are responsible for requiring one before an ECF can be submitted.
CREATE UNIQUE INDEX IF NOT EXISTS employee_form_roles_single_checker_uidx
  ON employee_form_roles(form_type)
  WHERE active=true AND role_code='CHECKER';

-- Employee-managed current beneficiary/bank preference. These values are
-- copied into ecf_details when a claim is submitted so historical claims do
-- not change when the profile is edited later.
CREATE TABLE IF NOT EXISTS employee_payment_profiles (
  employee_email text PRIMARY KEY REFERENCES employees(email) ON DELETE CASCADE,
  payment_to text NOT NULL DEFAULT '',
  bank_name text NOT NULL DEFAULT '',
  bank_code text NOT NULL DEFAULT '',
  account_number text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ECF-only request snapshot. ERF rows never need a matching row here.
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

CREATE INDEX IF NOT EXISTS ecf_details_checker_idx
  ON ecf_details(checker_email);

-- Add ECF-specific workflow states without changing the meaning of any
-- existing ERF states.
ALTER TABLE requests
  DROP CONSTRAINT IF EXISTS requests_status_check;

ALTER TABLE requests
  ADD CONSTRAINT requests_status_check
  CHECK (status IN (
    'PENDING_CHECK',
    'CHECK_REJECTED',
    'PENDING_REVIEW',
    'RECALLED',
    'REVIEW_REJECTED',
    'PENDING_APPROVAL',
    'APPROVAL_REJECTED',
    'APPROVED'
  ));

COMMIT;
