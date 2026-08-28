const CFG = Object.freeze({
  APP_NAME: 'Metrotech Expense Approval System',
  TEMPLATE_SPREADSHEET_ID: '1SmiA3Q8C2jn7Qhwen_GalYgiVJK-Sy3aZR1XWS-RoW0',
  TEMPLATE_SHEET_NAME: '',
  ALLOWED_DOMAIN: '',
  REVIEWER_NAME: 'Dimas Jenar',
  APPROVER_NAME: 'Ervan Mardianto',
  FINAL_APPROVED_CC: '',
  MAIL_SENDER_NAME: 'Metrotech Expense Approval System',
  REF_PREFIX: 'ERF',
  REF_SEQUENCE_DIGITS: 4,
  MAX_ITEMS: 16,
  MAX_EVIDENCE_TOTAL_MB: 12,
  ITEM_START_ROW: 16,
  ITEM_END_ROW: 31,
  CELLS: {
    requestDate: 'G3',
    refNo: 'G4',
    employeeName: 'D9',
    employeeId: 'D10',
    department: 'D11',
    location: 'D12',
    division: 'D13',
    total: 'G32',
    preparedBy: 'B37',
    reviewedBy: 'E37',
    approvedBy: 'F37'
  },
  SIGNATURES: {
    prepared: { col: 2, row: 35, width: 120, height: 46, x: 14, y: 2 },
    reviewed: { col: 5, row: 35, width: 120, height: 46, x: 60, y: 2 },
    approved: { col: 6, row: 35, width: 120, height: 46, x: 54, y: 2 }
  }
});

const ROLE = Object.freeze({
  REQUESTOR: 'REQUESTOR',
  REVIEWER: 'REVIEWER',
  APPROVER: 'APPROVER'
});

const STATUS = Object.freeze({
  PENDING_REVIEW: 'PENDING_REVIEW',
  REVIEW_REJECTED: 'REVIEW_REJECTED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  APPROVED: 'APPROVED'
});

const PROP = Object.freeze({
  DATA_SPREADSHEET_ID: 'DATA_SPREADSHEET_ID',
  OUTPUT_FOLDER_ID: 'OUTPUT_FOLDER_ID'
});
