ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'EXPENSE';

UPDATE requests
SET request_type='EXPENSE'
WHERE request_type IS NULL OR request_type='';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='requests_request_type_check'
  ) THEN
    ALTER TABLE requests
      ADD CONSTRAINT requests_request_type_check
      CHECK (request_type IN ('EXPENSE','REIMBURSEMENT'));
  END IF;
END $$;
