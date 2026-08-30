-- Development reset for Metrotech ERF.
-- Keeps only the bootstrap ADMIN account and removes all workflow/test data.

BEGIN;

TRUNCATE TABLE
  email_log,
  workflow_actions,
  request_items,
  requests,
  daily_counters
RESTART IDENTITY CASCADE;

DO $$
BEGIN
  IF to_regclass('public.session') IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE session';
  END IF;
END $$;

DELETE FROM employees
WHERE role <> 'ADMIN';

INSERT INTO employees(
  email,name,employee_id,department,location,division,role,
  signature_file,active,username,password_hash
)
VALUES(
  'admin-dev@metrotech.local',
  'ERF Administrator',
  'ADMIN-001',
  'IT',
  'Jakarta',
  'Administration',
  'ADMIN',
  '',
  true,
  'admin',
  crypt('dev123',gen_salt('bf',10))
)
ON CONFLICT (email) DO UPDATE SET
  name=EXCLUDED.name,
  employee_id=EXCLUDED.employee_id,
  department=EXCLUDED.department,
  location=EXCLUDED.location,
  division=EXCLUDED.division,
  role='ADMIN',
  signature_file='',
  active=true,
  username='admin',
  password_hash=crypt('dev123',gen_salt('bf',10));

COMMIT;
