ALTER TABLE daily_counters
  ADD COLUMN IF NOT EXISTS request_type text;

UPDATE daily_counters
SET request_type='EXPENSE'
WHERE request_type IS NULL OR request_type='';

ALTER TABLE daily_counters
  ALTER COLUMN request_type SET DEFAULT 'EXPENSE';

ALTER TABLE daily_counters
  ALTER COLUMN request_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='daily_counters_request_type_check'
  ) THEN
    ALTER TABLE daily_counters
      ADD CONSTRAINT daily_counters_request_type_check
      CHECK (request_type IN ('EXPENSE','REIMBURSEMENT'));
  END IF;
END $$;

ALTER TABLE daily_counters
  DROP CONSTRAINT IF EXISTS daily_counters_pkey;

ALTER TABLE daily_counters
  ADD CONSTRAINT daily_counters_pkey PRIMARY KEY(counter_date,request_type);
