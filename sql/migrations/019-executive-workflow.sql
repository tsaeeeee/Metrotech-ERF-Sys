-- Existing permissions, assignments, notes and transactions remain unchanged.
BEGIN;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS workflow_options jsonb;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS workflow_plan jsonb;
ALTER TABLE requests ALTER COLUMN reviewer_email DROP NOT NULL;
ALTER TABLE ecf_details ALTER COLUMN checker_email DROP NOT NULL;
ALTER TABLE ecf_details ALTER COLUMN checker_name DROP NOT NULL;

CREATE OR REPLACE FUNCTION workflow_member(members jsonb, email text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(members,'[]'::jsonb)) m
    WHERE lower(m->>'email')=lower(email))
$$;

CREATE OR REPLACE FUNCTION request_review_available(plan jsonb, assigned text, email text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN plan IS NULL THEN lower(assigned)=lower(email)
    WHEN coalesce((plan->>'bypass')::boolean,false) THEN false
    WHEN coalesce((plan->>'reviewTakenOver')::boolean,false) THEN lower(assigned)=lower(email)
    ELSE workflow_member(plan->'reviewers',email) END
$$;
COMMIT;
