-- Additive upgrade. NULL preserves each user's existing ERF/ECF permissions.
-- No employee, password, request, history, or assignment is rewritten.
BEGIN;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS workflow_roles jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_workflow_roles_check' AND conrelid='employees'::regclass) THEN
    ALTER TABLE employees ADD CONSTRAINT employees_workflow_roles_check CHECK (
      workflow_roles IS NULL OR (
        jsonb_typeof(workflow_roles)='object'
        AND workflow_roles ?& ARRAY['ERF','ECF']
        AND workflow_roles - 'ERF' - 'ECF' = '{}'::jsonb
        AND jsonb_typeof(workflow_roles->'ERF')='array'
        AND jsonb_typeof(workflow_roles->'ECF')='array'
        AND (workflow_roles->'ERF') <@ '["REQUESTOR","REVIEWER","APPROVER"]'::jsonb
        AND (workflow_roles->'ECF') <@ '["REQUESTOR","CHECKER","REVIEWER","APPROVER"]'::jsonb
      )
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION employee_has_workflow_role(p_email text,p_form text,p_role text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT e.active AND e.role<>'ADMIN' AND
    CASE WHEN e.workflow_roles IS NOT NULL THEN coalesce((e.workflow_roles->p_form) ? p_role,false)
      WHEN p_form='ERF' THEN e.role=p_role
      WHEN p_form='ECF' THEN EXISTS(SELECT 1 FROM admin_ecf_roles a WHERE a.email=e.email AND a.ecf_role=p_role)
      ELSE false END
    FROM employees e WHERE lower(e.email)=lower(p_email)),false)
$$;
COMMIT;
