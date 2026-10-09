import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

process.env.POSTGRES_HOST||='127.0.0.1';
process.env.POSTGRES_PORT||='5432';
process.env.POSTGRES_DB||='metrotech_erf';
process.env.POSTGRES_USER||='metrotech_erf';
process.env.POSTGRES_PASSWORD||='testpass';
process.env.PDF_DIR='/tmp/ems-http-smoke';
process.env.PORT='18989';

const base='http://127.0.0.1:18989';
const {pool,getEmployee,createExpenseRequest,getRequestDetail,recallApprovedExpenseRequest,setDocumentPaths}=await import('../src/db.js');
const server=spawn(process.execPath,['--import','./src/ecf-profile-preload.js','src/server.js'],{
  env:process.env,stdio:['ignore','pipe','pipe']
});
let output='';
server.stdout.on('data',chunk=>output+=chunk.toString());
server.stderr.on('data',chunk=>output+=chunk.toString());

function assert(value,message){if(!value) throw new Error(message)}
async function request(path,{method='GET',body,cookie}={}){
  const response=await fetch(base+path,{
    method,headers:{...(cookie?{Cookie:cookie}:{}),
      ...(!(body instanceof FormData)&&body?{'Content-Type':'application/json'}:{})},
    body:body instanceof FormData?body:body?JSON.stringify(body):undefined
  });
  const data=response.headers.get('content-type')?.includes('json')
    ?await response.json():null;
  return {status:response.status,data,cookie:response.headers.get('set-cookie'),response};
}
async function login(username){
  const result=await request('/api/login',{method:'POST',body:{username,password:'ci-only'}});
  assert(result.status===200,`Login failed for ${username}: ${JSON.stringify(result.data)}`);
  return result.cookie.split(';')[0];
}

try{
  let healthy=false;
  for(let attempt=0;attempt<50;attempt++){
    if(server.exitCode!==null) throw new Error(`App exited early: ${output}`);
    try{healthy=(await request('/health')).status===200}catch{}
    if(healthy) break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert(healthy,`App did not start: ${output}`);

  const requestor=await getEmployee('requestor-test@metrotech.local');
  const approver=await getEmployee('approver-test@metrotech.local');
  const erf=await createExpenseRequest(requestor,[{
    category:'Testing',purpose:'Pending ERF',paymentDate:'2026-09-23',
    amount:100000,evidenceNames:[]
  }]);

  const requestorCookie=await login('workflow-requestor');
  const evidence=await PDFDocument.create();
  evidence.addPage([200,200]);
  const form=new FormData();
  form.set('serviceOrderNumber','SO-HTTP-01');
  form.set('items',JSON.stringify([{
    category:'Testing',purpose:'Claim route',paymentDate:'2026-09-23',amount:20000
  }]));
  form.set('evidence_0',new Blob([await evidence.save()],{type:'application/pdf'}),'proof.pdf');
  const submitted=await request('/api/ecf/claims',{method:'POST',body:form,cookie:requestorCookie});
  assert(submitted.status===201&&submitted.data.status==='PENDING_CHECK',
    `ECF submit failed: ${JSON.stringify(submitted.data)}`);
  const id=submitted.data.requestId;
  const detail=await request(`/api/requests/${id}`,{cookie:requestorCookie});
  assert(detail.status===200&&!detail.data.request.source_erf_id&&
    detail.data.documents.packet&&detail.data.documents.evidence,
    'Independent claim detail must include both document views.');
  assert((await pool.query('select status from requests where id=$1',[erf.id])).rows[0].status==='PENDING_REVIEW',
    'ECF submission must work without an approved ERF.');
  const tasksCookie=await login('workflow-requestor');
  assert((await request('/api/me',{cookie:tasksCookie})).data.myRequests.some(row=>row.id===id),
    'My Requests must include the submitted ECF.');
  const second=new FormData();
  second.set('items',JSON.stringify([{
    category:'Testing',purpose:'Another claim',paymentDate:'2026-09-23',amount:90000
  }]));
  second.set('evidence_0',new Blob([await evidence.save()],{type:'application/pdf'}),'proof.pdf');
  assert((await request('/api/ecf/claims',{method:'POST',body:second,cookie:requestorCookie})).status===201,
    'ECF claims must not be limited by unrelated ERF totals.');
  assert((await request('/api/requests',{method:'POST',body:{requestType:'REIMBURSEMENT'},cookie:requestorCookie})).status===400,
    'New reimbursement submissions must use the separate ECF flow.');

  assert((await request(`/api/requests/${id}/recall`,{method:'POST',body:{},cookie:requestorCookie})).data.status==='RECALLED',
    'Requestor must be able to recall a claim before checking.');
  const revision=new FormData();
  revision.set('serviceOrderNumber','SO-HTTP-REVISED');
  revision.set('items',JSON.stringify([{
    category:'Testing',purpose:'Revised claim',paymentDate:'2026-09-23',amount:25000,sourceLineNo:1
  }]));
  const revised=await request(`/api/requests/${id}/revise`,{method:'POST',body:revision,cookie:requestorCookie});
  assert(revised.status===200&&revised.data.status==='PENDING_CHECK',
    `ECF revision failed: ${JSON.stringify(revised.data)}`);
  const revisedDetail=await request(`/api/requests/${id}`,{cookie:requestorCookie});
  assert(revisedDetail.data.request.service_order_number==='SO-HTTP-REVISED',
    'ECF revision must persist the edited Service Order number.');
  assert(revisedDetail.data.request.account_number===detail.data.request.account_number,
    'ECF revision must preserve the submitted payment-profile snapshot.');
  assert(revisedDetail.data.items[0].evidence_names.includes('proof.pdf'),
    'ECF revision must retain existing evidence.');

  const checkerCookie=await login('workflow-checker');
  const tasks=await request('/api/me',{cookie:checkerCookie});
  assert(tasks.data.employee.role==='NONE' && tasks.data.employee.ecfRole==='CHECKER',
    'ECF Checker must still work with no ERF access.');
  assert(tasks.data.tasks.some(row=>row.id===id),'Checker must see pending claim in My Tasks.');
  assert((await request(`/api/requests/${id}/check`,{
    method:'POST',body:{decision:'APPROVE'},cookie:checkerCookie
  })).data.status==='PENDING_REVIEW','Checker must pass claim to Reviewer.');
  const reviewer=await getEmployee(detail.data.request.reviewer_email);
  const reviewerCookie=await login(reviewer.username);
  assert((await request(`/api/requests/${id}/review`,{
    method:'POST',body:{decision:'APPROVE'},cookie:reviewerCookie
  })).data.status==='PENDING_APPROVAL','Reviewer must pass claim to Approver.');
  const approverCookie=await login(approver.username);
  assert((await request(`/api/requests/${id}/approve`,{
    method:'POST',body:{decision:'APPROVE'},cookie:approverCookie
  })).data.status==='APPROVED','Approver must finalize claim.');
  const final=await request(`/api/requests/${id}/form/download`,{cookie:requestorCookie});
  assert(final.status===200,'Requestor must be able to download approved ECF packet.');

  for(const [role,cookie] of [['Requestor',requestorCookie],['Checker',checkerCookie],
    ['Reviewer',reviewerCookie],['Approver',approverCookie]]){
    const me=await request('/api/me',{cookie});
    assert(me.status===200 && me.data.history.some(row=>row.id===id && row.form_type==='ECF'),
      `${role} must see the completed ECF in History.`);
    assert(!me.data.tasks.some(row=>row.id===id),`${role} must not see completed ECF in My Tasks.`);
    const historic=await request(`/api/requests/${id}`,{cookie});
    assert(historic.status===200,`${role} must be able to open ECF from History.`);
    assert(historic.data.actions.some(action=>action.action==='CHECK_APPROVED' && action.actor_role==='CHECKER'),
      'Checker audit role must be correct.');
  }

  // Approval recall must cover ECF as well as ERF, with the same archive and ownership guarantees.
  const approvedEcf=await getRequestDetail(id);
  const approvedBytes=Buffer.from(await final.response.arrayBuffer());
  for(const cookie of [requestorCookie,checkerCookie,reviewerCookie]){
    assert((await request(`/api/requests/${id}/recall`,{
      method:'POST',body:{reason:'Not the Approver'},cookie
    })).status>=400,'Only the assigned Approver may recall an approved ECF.');
  }
  let wrongApproverDenied=false;
  try{await recallApprovedExpenseRequest(id,{...approver,email:'other-approver@example.test'},'Wrong assignment')}
  catch(error){wrongApproverDenied=error.status===403}
  assert(wrongApproverDenied,'A different Approver must not recall the ECF.');
  assert((await request(`/api/requests/${id}/recall`,{
    method:'POST',body:{reason:'  '},cookie:approverCookie
  })).status===400,'Approval recall requires a reason.');
  await setDocumentPaths(id,`${process.env.PDF_DIR}/missing-approved-claim.pdf`,approvedEcf.request.evidence_pdf_path);
  let archiveFailure=false;
  try{await recallApprovedExpenseRequest(id,approver,'Missing approved PDF')}
  catch(error){archiveFailure=error.status===409}
  assert(archiveFailure && (await getRequestDetail(id)).request.status==='APPROVED',
    'Missing ECF archive must leave the approval intact.');
  await setDocumentPaths(id,approvedEcf.request.form_pdf_path,approvedEcf.request.evidence_pdf_path);
  const recallResults=await Promise.all([1,2].map(()=>request(`/api/requests/${id}/recall`,{
    method:'POST',body:{reason:'Correct the claim amount'},cookie:approverCookie
  })));
  assert(recallResults.filter(result=>result.status===200).length===1 && recallResults.every(result=>[200,403,409].includes(result.status)),
    'Duplicate ECF recalls must produce exactly one successful transition.');
  const recallMails=(await pool.query("select mail_to,mail_cc from email_log where request_id=$1 and event='APPROVAL_RECALLED'",[id])).rows;
  assert(recallMails.length===1 && recallMails[0].mail_cc.split(',').includes(approver.email), 'Approval Recall must email its assigned Approver exactly once.');
  const recalledEcf=await getRequestDetail(id);
  assert(recalledEcf.request.status==='RECALLED','Approved ECF must become Recalled.');
  const recallActions=recalledEcf.actions.filter(action=>action.action==='APPROVAL_RECALLED');
  assert(recallActions.length===1 && recallActions[0].actor_role==='APPROVER' &&
    recallActions[0].reason==='Correct the claim amount','ECF recall must be recorded in the audit trail.');
  assert((await request(`/api/requests/${id}/form/download`,{cookie:requestorCookie})).status===409,
    'The recalled approval must not be downloadable as current.');
  const archiveUrl=`/api/requests/${id}/approval-archive/${approvedEcf.request.revision}`;
  const archivedEcf=await request(archiveUrl,{cookie:requestorCookie});
  assert(archivedEcf.status===200 && approvedBytes.equals(Buffer.from(await archivedEcf.response.arrayBuffer())),
    'Archive must preserve the exact previously approved ECF PDF.');
  const resubmittedEcf=await request(`/api/requests/${id}/revise`,{
    method:'POST',body:revision,cookie:requestorCookie
  });
  assert(resubmittedEcf.status===200 && resubmittedEcf.data.status==='PENDING_CHECK',
    'A recalled ECF must restart with Checker after Requestor revision.');
  assert((await request(`/api/requests/${id}/approve`,{
    method:'POST',body:{decision:'APPROVE'},cookie:approverCookie
  })).status===409,'Approver must not bypass the new ECF check/review.');
  for(const [stage,cookie,state] of [['check',checkerCookie,'PENDING_REVIEW'],
    ['review',reviewerCookie,'PENDING_APPROVAL'],['approve',approverCookie,'APPROVED']]){
    const result=await request(`/api/requests/${id}/${stage}`,{method:'POST',body:{decision:'APPROVE'},cookie});
    assert(result.status===200 && result.data.status===state,`Recalled ECF must pass ${stage} again.`);
  }
  assert((await request(`/api/requests/${id}/form/download`,{cookie:requestorCookie})).status===200,
    'The new ECF approval must be downloadable.');
  const archivedAgain=await request(archiveUrl,{cookie:requestorCookie});
  assert(archivedAgain.status===200 && approvedBytes.equals(Buffer.from(await archivedAgain.response.arrayBuffer())),
    'Reapproval must not overwrite the previous ECF archive.');

  const ecfOnlyCookie=await login('workflow-ecf-only');
  const ecfOnlyMe=await request('/api/me',{cookie:ecfOnlyCookie});
  assert(!ecfOnlyMe.data.history.some(row=>row.id===id),'Unrelated Requestor cannot see another claim in History.');
  assert((await request(`/api/requests/${id}`,{cookie:ecfOnlyCookie})).status===403,
    'Unrelated Requestor cannot open another claim.');
  assert(ecfOnlyMe.data.employee.role==='NONE' && ecfOnlyMe.data.employee.ecfRole==='REQUESTOR',
    'ECF-only Requestor needs ECF access with no ERF access.');
  assert(ecfOnlyMe.data.requests.every(row=>row.form_type==='ECF') &&
    ecfOnlyMe.data.myRequests.every(row=>row.form_type==='ECF'),
    'ECF-only Requestor must not receive ERF requests.');
  assert((await request('/api/requests',{method:'POST',body:{requestType:'EXPENSE'},
    cookie:ecfOnlyCookie})).status===403,'ECF-only Requestor must be denied ERF creation.');
  const claimForm=new FormData();
  claimForm.set('items',JSON.stringify([{
    category:'Testing',purpose:'ECF-only claim',paymentDate:'2026-09-23',amount:12000
  }]));
  claimForm.set('evidence_0',new Blob([await evidence.save()],{type:'application/pdf'}),'proof.pdf');
  const ecfOnlyClaim=await request('/api/ecf/claims',{
    method:'POST',body:claimForm,cookie:ecfOnlyCookie
  });
  assert(ecfOnlyClaim.status===201,'ECF-only Requestor must be able to submit claims.');
  const ecfOnlyId=ecfOnlyClaim.data.requestId;
  assert((await request(`/api/requests/${ecfOnlyId}/recall`,{
    method:'POST',body:{},cookie:ecfOnlyCookie
  })).data.status==='RECALLED','ECF-only Requestor must be able to recall their claim.');
  const ecfOnlyRevision=new FormData();
  ecfOnlyRevision.set('items',JSON.stringify([{
    category:'Testing',purpose:'ECF-only revision',paymentDate:'2026-09-23',
    amount:14000,sourceLineNo:1
  }]));
  const ecfOnlyRevised=await request(`/api/requests/${ecfOnlyId}/revise`,{
    method:'POST',body:ecfOnlyRevision,cookie:ecfOnlyCookie
  });
  assert(ecfOnlyRevised.status===200 && ecfOnlyRevised.data.status==='PENDING_CHECK',
    'ECF-only Requestor must be able to revise their recalled claim.');
  console.log('EMS_HTTP_SMOKE_OK');
}catch(error){
  console.error(error,output.slice(-3000));
  process.exitCode=1;
}finally{
  server.kill('SIGTERM');
  await pool.end();
  await fs.rm(process.env.PDF_DIR,{recursive:true,force:true});
}
