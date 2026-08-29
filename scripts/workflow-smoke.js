import fs from 'node:fs/promises';

process.env.POSTGRES_HOST ||= '127.0.0.1';
process.env.POSTGRES_PORT ||= '5432';
process.env.POSTGRES_DB ||= 'metrotech_erf';
process.env.POSTGRES_USER ||= 'metrotech_erf';
process.env.POSTGRES_PASSWORD ||= 'testpass';
process.env.REVIEWER_NAME ||= 'Dimas Jenar';
process.env.APPROVER_NAME ||= 'Ervan Mardianto';

const {
  pool,getEmployee,createExpenseRequest,transitionRequest,
  reviseExpenseRequest,recallExpenseRequest
}=await import('../src/db.js');

function assert(condition,message){
  if(!condition) throw new Error(message);
}
function items(label){
  return [{
    category:'Testing',
    purpose:label,
    paymentDate:'2026-08-29',
    amount:100000,
    evidenceNames:['evidence.pdf']
  }];
}

try{
  const schema=await fs.readFile(new URL('../sql/schema.sql',import.meta.url),'utf8');
  await pool.query(schema);
  const devSeed=await fs.readFile(new URL('../sql/dev-accounts.sql',import.meta.url),'utf8');
  await pool.query(devSeed);

  const requestor=await getEmployee('requestor-dev@metrotech.local');
  const reviewer=await getEmployee('reviewer-dev@metrotech.local');
  const approver=await getEmployee('approver-dev@metrotech.local');
  assert(requestor&&reviewer&&approver,'Dev actors were not seeded.');

  const first=await createExpenseRequest(requestor,items('Initial submit'));
  assert(first.status==='PENDING_REVIEW','Submit must enter PENDING_REVIEW.');

  const rejected=await transitionRequest(first.id,reviewer,'REVIEW','REJECT','Please revise.');
  assert(rejected.status==='REVIEW_REJECTED','Reviewer reject must enter REVIEW_REJECTED.');

  const revised=await reviseExpenseRequest(first.id,requestor,items('Revision 2'));
  assert(revised.status==='PENDING_REVIEW','Revision must return to PENDING_REVIEW.');
  assert(Number(revised.revision)===2,'Revision counter must become 2.');

  const reviewed=await transitionRequest(first.id,reviewer,'REVIEW','APPROVE','');
  assert(reviewed.status==='PENDING_APPROVAL','Reviewer approval after revision must enter PENDING_APPROVAL.');

  const approverRejected=await transitionRequest(first.id,approver,'APPROVAL','REJECT','Fix final detail.');
  assert(approverRejected.status==='APPROVAL_REJECTED','Approver reject must enter APPROVAL_REJECTED.');

  const revisedAgain=await reviseExpenseRequest(first.id,requestor,items('Revision 3'));
  assert(revisedAgain.status==='PENDING_REVIEW','Approver-rejected revision must restart at PENDING_REVIEW.');
  assert(Number(revisedAgain.revision)===3,'Revision counter must become 3.');

  const reviewedAgain=await transitionRequest(first.id,reviewer,'REVIEW','APPROVE','');
  assert(reviewedAgain.status==='PENDING_APPROVAL','Reviewer must be able to approve revision 3.');

  const finalApproved=await transitionRequest(first.id,approver,'APPROVAL','APPROVE','');
  assert(finalApproved.status==='APPROVED','Final approval must enter APPROVED.');

  const recalledRequest=await createExpenseRequest(requestor,items('Recall flow'));
  const recalled=await recallExpenseRequest(recalledRequest.id,requestor);
  assert(recalled.status==='RECALLED','Recall must enter RECALLED.');

  const resubmitted=await reviseExpenseRequest(recalledRequest.id,requestor,items('Recall resubmission'));
  assert(resubmitted.status==='PENDING_REVIEW','Recalled request must return to PENDING_REVIEW on resubmit.');
  const recallReviewed=await transitionRequest(recalledRequest.id,reviewer,'REVIEW','APPROVE','');
  assert(recallReviewed.status==='PENDING_APPROVAL','Reviewer must approve a recalled/resubmitted request.');

  console.log('WORKFLOW_SMOKE_OK');
} finally {
  await pool.end();
}
