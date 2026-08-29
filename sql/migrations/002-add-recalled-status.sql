ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;

ALTER TABLE requests
ADD CONSTRAINT requests_status_check
CHECK (
  status IN (
    'PENDING_REVIEW',
    'RECALLED',
    'REVIEW_REJECTED',
    'PENDING_APPROVAL',
    'APPROVAL_REJECTED',
    'APPROVED'
  )
);
