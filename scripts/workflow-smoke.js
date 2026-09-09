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
  reviseExpenseRequest,recallExpenseRequest,createManagedEmployee,setManagedEmployeeActive
}=await import('../src/db.js');

function assert(condition,message){
  if(!condition) throw new Error(message);
}
function items(label){
  return [{category:'Testing',purpose:label,paymentDate:'2026-08-29',amount:100000,evidenceNames:['evidence.pdf']}];
}

try{
  const schema=await fs.readFile(new URL('../sql/schema.sql',import.meta.url),'utf8');
  await pool.query(schema);
  const adminSeed=await fs.readFile(new URL('../sql/dev-accounts.sql',import.meta.url),'utf8');
  await pool.query(adminSeed);

  const bootstrapAdmin=await getEmployee('admin-dev@metrotech.local');
  assert(bootstrapAdmin?.role==='ADMIN','Bootstrap Administrator must exist.');

  const {saveAppSettings,getPublicAppSettings,getRuntimeAppSettings}=await import('../src/settings.js');
  await saveAppSettings({
    appBaseUrl:'https://expense.metrotech.id',
    smtpEnabled:false,
    smtpPassword:'ci-secret-value'
  },bootstrapAdmin.email);
  const publicSettings=await getPublicAppSettings();
  const runtimeSettings=await getRuntimeAppSettings();
  assert(publicSettings.smtpPasswordConfigured===true,'SMTP secret should report as configured.');
  assert(!Object.prototype.hasOwnProperty.call(publicSettings,'smtpPass'),'Public settings must not expose SMTP password.');
  assert(runtimeSettings.smtpPass==='ci-secret-value','Encrypted SMTP secret must decrypt for runtime use.');

  let authLockoutBlocked=false;
  try{
    await saveAppSettings({localLoginEnabled:false,googleEnabled:false},bootstrapAdmin.email);
  }catch(e){
    authLockoutBlocked=e.status===409;
  }
  assert(authLockoutBlocked,'App settings must prevent disabling every authentication path.');

  await pool.query(`
    insert into employees(
      email,name,employee_id,department,location,division,role,signature_file,active,username,password_hash
    ) values
      ('requestor-test@metrotech.local','Workflow Requestor','TEST-001','Operations','Jakarta','Service Operations','REQUESTOR','/tmp/ci-requestor-signature.png',true,'workflow-requestor',crypt('ci-only',gen_salt('bf',10))),
      ('reviewer-test@metrotech.local','Dimas Jenar','TEST-002','Operations','Jakarta','Service Operations','REVIEWER','/tmp/ci-reviewer-signature.png',true,'workflow-reviewer',crypt('ci-only',gen_salt('bf',10))),
      ('reviewer2-test@metrotech.local','Reviewer Dua','TEST-004','Operations','Jakarta','Service Operations','REVIEWER','/tmp/ci-reviewer2-signature.png',true,'workflow-reviewer2',crypt('ci-only',gen_salt('bf',10))),
      ('approver-test@metrotech.local','Ervan Mardianto','TEST-003','Management','Jakarta','Management','APPROVER','/tmp/ci-approver-signature.png',true,'workflow-approver',crypt('ci-only',gen_salt('bf',10)))
    on conflict(email) do nothing
  `);

  const requestor=await getEmployee('requestor-test@metrotech.local');
  const reviewer=await getEmployee('reviewer-test@metrotech.local');
  const reviewer2=await getEmployee('reviewer2-test@metrotech.local');
  const approver=await getEmployee('approver-test@metrotech.local');
  assert(requestor&&reviewer&&reviewer2&&approver,'Workflow test actors were not seeded.');

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

  const routedA=await createExpenseRequest(requestor,items('Routing A'));
  const routedB=await createExpenseRequest(requestor,items('Routing B'));
  assert(
    String(routedA.reviewer_email).toLowerCase()!==String(routedB.reviewer_email).toLowerCase(),
    'Two equally available reviewers should receive separate pending requests.'
  );

  const removedEmail=routedA.reviewer_email;
  await setManagedEmployeeActive(removedEmail,false);
  const {rows:reassignedRows}=await pool.query('select reviewer_email from requests where id=$1',[routedA.id]);
  assert(
    String(reassignedRows[0].reviewer_email).toLowerCase()!==String(removedEmail).toLowerCase(),
    'Pending review must be reassigned when its reviewer is removed.'
  );

  let duplicateApproverBlocked=false;
  try{
    await createManagedEmployee({
      name:'Second Approver',email:'approver2-test@metrotech.local',username:'workflow-approver2',
      password:'ci-only',employeeId:'TEST-005',department:'Management',location:'Jakarta',division:'Management',role:'APPROVER'
    });
  }catch(e){
    duplicateApproverBlocked=e.status===409;
  }
  assert(duplicateApproverBlocked,'A second active Approver must be blocked.');

  console.log('WORKFLOW_SMOKE_OK');
} finally {
  await pool.end();
}
