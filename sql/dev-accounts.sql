INSERT INTO employees(
  email,name,employee_id,department,location,division,role,signature_file,active
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
    true
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
    true
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
    true
  )
ON CONFLICT (email) DO UPDATE SET
  name=EXCLUDED.name,
  employee_id=EXCLUDED.employee_id,
  department=EXCLUDED.department,
  location=EXCLUDED.location,
  division=EXCLUDED.division,
  role=EXCLUDED.role,
  signature_file=EXCLUDED.signature_file,
  active=true;
