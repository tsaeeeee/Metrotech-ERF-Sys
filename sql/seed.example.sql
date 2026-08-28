-- EXAMPLE ONLY. Replace with real company data and keep production seed files private.
-- Reviewer and Approver names must match the configured fixed workflow actors.

INSERT INTO employees(email,name,employee_id,department,location,division,role,signature_file,active)
VALUES
  ('tsabit@metrotech.id','Tsabit','EMP-TEST-001','Operations','Jakarta','Service Operations','REQUESTOR','requestor.png',true),
  ('reviewer@example.com','Dimas Jenar','EMP-002','Operations','Jakarta','Service Operations','REVIEWER','dimas-jenar.png',true),
  ('approver@example.com','Ervan Mardianto','EMP-003','Management','Jakarta','Management','APPROVER','ervan-mardianto.png',true)
ON CONFLICT (email) DO NOTHING;
