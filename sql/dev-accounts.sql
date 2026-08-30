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
  signature_file=COALESCE(employees.signature_file,''),
  active=true,
  username=COALESCE(employees.username,EXCLUDED.username),
  password_hash=COALESCE(employees.password_hash,EXCLUDED.password_hash);
