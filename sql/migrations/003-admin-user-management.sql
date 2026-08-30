-- Add ADMIN role and database-backed local accounts.
-- Safe for the current development database.

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees
  ADD CONSTRAINT employees_role_check
  CHECK (role IN ('REQUESTOR','REVIEWER','APPROVER','ADMIN'));

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS password_hash text;

ALTER TABLE employees
  ALTER COLUMN signature_file SET DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS employees_username_lower_uidx
  ON employees(lower(username))
  WHERE username IS NOT NULL;

-- Keep existing development accounts working.
UPDATE employees
SET username='tsabit',
    password_hash=crypt('dev123',gen_salt('bf',10))
WHERE (
    lower(email) IN (lower('requestor-dev@metrotech.local'),lower('tsabit@metrotech.id'))
    OR lower(name)=lower('Tsabit Imanadi')
  )
  AND (username IS NULL OR password_hash IS NULL);

UPDATE employees
SET username='dimas',
    password_hash=crypt('dev123',gen_salt('bf',10))
WHERE (
    lower(email)=lower('reviewer-dev@metrotech.local')
    OR lower(name)=lower('Dimas Jenar')
  )
  AND (username IS NULL OR password_hash IS NULL);

UPDATE employees
SET username='ervan',
    password_hash=crypt('dev123',gen_salt('bf',10))
WHERE (
    lower(email)=lower('approver-dev@metrotech.local')
    OR lower(name)=lower('Ervan Mardianto')
  )
  AND (username IS NULL OR password_hash IS NULL);

INSERT INTO employees(
  email,name,employee_id,department,location,division,role,signature_file,active,username,password_hash
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
  active=true,
  username=COALESCE(employees.username,EXCLUDED.username),
  password_hash=COALESCE(employees.password_hash,EXCLUDED.password_hash);
