import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

process.env.POSTGRES_HOST ||= '127.0.0.1';
process.env.POSTGRES_PORT ||= '5432';
process.env.POSTGRES_DB ||= 'metrotech_erf';
process.env.POSTGRES_USER ||= 'metrotech_erf';
process.env.POSTGRES_PASSWORD ||= 'testpass';
process.env.REVIEWER_NAME ||= 'Dimas Jenar';
process.env.APPROVER_NAME ||= 'Ervan Mardianto';

const {
  pool,getEmployee,createExpenseRequest,transitionRequest,
  reviseExpenseRequest,recallExpenseRequest,createManagedEmployee,setManagedEmployeeActive,
  createEcfClaim,listTasksForEmployee,getEmsDashboard,getEcfRole,
  getRequestDetail
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
  for(const file of ['015-ems-foundation.sql','016-ems-claim-flow.sql']){
    const migration=await fs.readFile(new URL(`../sql/migrations/${file}`,import.meta.url),'utf8');
    await pool.query(migration);
  }
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

  // Exercise the real ECF Admin role-assignment path so PL/pgSQL ambiguity or
  // constraint regressions are caught by CI before reaching the browser.
  await saveAppSettings({
    ecfRoleAssignment:{
      email:requestor.email,
      role:'CHECKER',
      replaceChecker:false
    }
  },bootstrapAdmin.email);
  const {rows:ecfCheckerRows}=await pool.query(
    `select role_code from employee_form_roles
     where lower(employee_email)=lower($1) and form_type='ECF' and active=true`,
    [requestor.email]
  );
  assert(ecfCheckerRows.some(row=>row.role_code==='CHECKER'),'ECF Requestor must be assignable as Checker.');
  await saveAppSettings({
    ecfRoleAssignment:{
      email:requestor.email,
      role:'REQUESTOR',
      replaceChecker:false
    }
  },bootstrapAdmin.email);

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

  // A separate Checker owns the first ECF stage. Claims are independent of ERF.
  await pool.query(`insert into employees(
      email,name,employee_id,department,location,division,role,signature_file,active,username,password_hash
    ) values('checker-test@metrotech.local','Claim Checker','TEST-006','Finance','Jakarta',
      'Finance','REQUESTOR','/tmp/ci-checker-signature.png',true,'workflow-checker',crypt('ci-only',gen_salt('bf',10)))`);
  const checker=await getEmployee('checker-test@metrotech.local');
  await saveAppSettings({ecfRoleAssignment:{email:checker.email,role:'CHECKER'}},bootstrapAdmin.email);
  await pool.query(`insert into employee_payment_profiles
    (employee_email,payment_to,bank_name,bank_code,account_number)
    values($1,'Workflow Requestor','Bank Central Asia','BCA','123456789')`,[requestor.email]);
  const claimItems=amount=>[{...items('Independent claim')[0],amount}];
  const simultaneous=await Promise.allSettled([
    createEcfClaim(requestor,claimItems(60000)),
    createEcfClaim(requestor,claimItems(60000))
  ]);
  assert(simultaneous.every(result=>result.status==='fulfilled'),
    'Concurrent ECF claims must not require or reserve ERF balance.');
  const claim=simultaneous[0].value;
  assert(claim.status==='PENDING_CHECK'&&claim.form_type==='ECF','ECF must start with Checker.');
  assert((await pool.query('select source_erf_id from ecf_details where request_id=$1',[claim.id])).rows[0].source_erf_id===null,
    'New ECF claims must not reference an ERF.');
  await pool.query(`update employee_payment_profiles set account_number='999999999'
    where employee_email=$1`,[requestor.email]);
  const claimDetail=await getRequestDetail(claim.id);
  assert(claimDetail.request.account_number==='123456789',
    'Submitted claim must retain its original bank account snapshot.');
  const {buildFormPdf}=await import('../src/documents.js');
  const pdfPath='/tmp/ems-claim-smoke.pdf';
  await buildFormPdf({...claimDetail,outPath:pdfPath});
  const pdf=await PDFDocument.load(await fs.readFile(pdfPath));
  assert(pdf.getPageCount()===1,'ECF should generate its own signed form page.');
  await fs.rm(pdfPath,{force:true});
  assert((await getEcfRole(checker.email))==='CHECKER','Assigned Checker must retain access.');
  assert((await listTasksForEmployee(checker)).some(row=>row.id===claim.id),
    'Checker must see the claim in My Tasks.');
  await transitionRequest(claim.id,checker,'CHECK','REJECT','Please revise evidence.');
  await reviseExpenseRequest(claim.id,requestor,claimItems(170000));
  assert((await pool.query('select status from requests where id=$1',[claim.id])).rows[0].status==='PENDING_CHECK',
    'Revised claim returns to Checker without an ERF balance check.');
  await transitionRequest(claim.id,checker,'CHECK','APPROVE');
  const reviewerForClaim=await getEmployee(claim.reviewer_email);
  await transitionRequest(claim.id,reviewerForClaim,'REVIEW','APPROVE');
  await transitionRequest(claim.id,approver,'APPROVAL','APPROVE');
  const analytics=await getEmsDashboard(requestor);
  assert(analytics.totals.some(row=>row.form_type==='ECF'&&row.status==='APPROVED'),
    'EMS dashboard must include approved ECF claims.');

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
