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
const {pool,getEmployee,createExpenseRequest,transitionRequest}=await import('../src/db.js');
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
    category:'Testing',purpose:'HTTP route source',paymentDate:'2026-09-23',
    amount:100000,evidenceNames:[]
  }]);
  await transitionRequest(erf.id,await getEmployee(erf.reviewer_email),'REVIEW','APPROVE');
  await transitionRequest(erf.id,approver,'APPROVAL','APPROVE');

  const requestorCookie=await login('workflow-requestor');
  const eligible=await request('/api/ecf/eligible-erfs',{cookie:requestorCookie});
  assert(eligible.status===200&&eligible.data.erfs.some(row=>row.id===erf.id),
    'Eligible ERF route must include the approved source.');
  const evidence=await PDFDocument.create();
  evidence.addPage([200,200]);
  const form=new FormData();
  form.set('sourceErfId',erf.id);
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
  assert(detail.status===200&&detail.data.request.source_erf_id===erf.id&&
    detail.data.documents.packet&&detail.data.documents.evidence,
    'Claim detail must include source ERF and both document views.');
  const tasksCookie=await login('workflow-requestor');
  assert((await request('/api/me',{cookie:tasksCookie})).data.myRequests.some(row=>row.id===id),
    'My Requests must include the submitted ECF.');
  const oversized=new FormData();
  oversized.set('sourceErfId',erf.id);
  oversized.set('items',JSON.stringify([{
    category:'Testing',purpose:'Over balance',paymentDate:'2026-09-23',amount:90000
  }]));
  oversized.set('evidence_0',new Blob([await evidence.save()],{type:'application/pdf'}),'proof.pdf');
  assert((await request('/api/ecf/claims',{method:'POST',body:oversized,cookie:requestorCookie})).status===409,
    'Submit API must reject claims above the remaining balance.');

  const checkerCookie=await login('workflow-checker');
  const tasks=await request('/api/me',{cookie:checkerCookie});
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
  console.log('EMS_HTTP_SMOKE_OK');
}catch(error){
  console.error(error,output.slice(-3000));
  process.exitCode=1;
}finally{
  server.kill('SIGTERM');
  await pool.end();
  await fs.rm(process.env.PDF_DIR,{recursive:true,force:true});
}
