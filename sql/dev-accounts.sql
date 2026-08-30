INSERT INTO employees(
  email,name,employee_id,department,location,division,role,signature_file,active,username,password_hash
)
VALUES
  (
    'requestor-dev@metrotech.local',
    'Tsabit Imanadi',
    'DEV-001',
    'Operations',
    'Jakarta',
    'Service Operations',
    'REQUESTOR',
    'requestor-test.png',
    true,
    'tsabit',
    crypt('dev123',gen_salt('bf',10))
  ),
  (
    'reviewer-dev@metrotech.local',
    'Dimas Jenar',
    'DEV-002',
    'Operations',
    'Jakarta',
    'Service Operations',
    'REVIEWER',
    'reviewer-test.png',
    true,
    'dimas',
    crypt('dev123',gen_salt('bf',10))
  ),
  (
    'approver-dev@metrotech.local',
    'Ervan Mardianto',
    'DEV-003',
    'Management',
    'Jakarta',
    'Management',
    'APPROVER',
    'approver-test.png',
    true,
    'ervan',
    crypt('dev123',gen_salt('bf',10))
  ),
  (
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
  role=EXCLUDED.role,
  signature_file=EXCLUDED.signature_file,
  active=true,
  username=COALESCE(employees.username,EXCLUDED.username),
  password_hash=COALESCE(employees.password_hash,EXCLUDED.password_hash);
