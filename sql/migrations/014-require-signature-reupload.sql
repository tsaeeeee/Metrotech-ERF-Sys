ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS must_upload_signature boolean NOT NULL DEFAULT false;

UPDATE employees
SET must_change_password=true,
    must_upload_signature=true
WHERE role<>'ADMIN';
