import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';
import {DraftStore} from '../src/drafts.js';

process.env.POSTGRES_HOST||='127.0.0.1';process.env.POSTGRES_PORT||='5432';
process.env.POSTGRES_DB||='metrotech_erf';process.env.POSTGRES_USER||='metrotech_erf';process.env.POSTGRES_PASSWORD||='testpass';
const root=await fs.mkdtemp('/tmp/ems-drafts-test-');
process.env.PDF_DIR=root;process.env.PORT='18991';
const {pool,getEmployee,createExpenseRequest}=await import('../src/db.js');
const origin='http://127.0.0.1:18991';
let server,output='';
async function http(url,cookie,method='GET',body){
  const response=await fetch(origin+url,{method,headers:{...(cookie?{cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const data=response.headers.get('content-type')?.includes('json')?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function start(){
  server=spawn(process.execPath,['--import','./src/ecf-profile-preload.js','src/server.js'],{env:process.env,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',c=>output+=c);server.stderr.on('data',c=>output+=c);
  for(let n=0;n<60;n++){
    if(server.exitCode!==null)throw new Error(output);
    try{if((await http('/health')).status===200)return}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error('Draft test server did not start. '+output);
}
async function stop(){if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit')}}
async function login(username){const r=await http('/api/login',null,'POST',{username,password:'ci-only'});assert.equal(r.status,200,JSON.stringify(r.data));return r.cookie}
const empty={category:'',purpose:'',paymentDate:'2026-10-27',amount:''};
const payment={category:'Meals',purpose:'Draft receipt',paymentDate:'2026-10-27',amount:25000};
const pdf=await PDFDocument.create();pdf.addPage([100,100]);const proof=Buffer.from(await pdf.save());
function form(payload,version,field){const f=new FormData();f.append('draft',JSON.stringify(payload));if(version)f.append('version',String(version));if(field)f.append(field,new Blob([proof],{type:'application/pdf'}),'receipt.pdf');return f}
async function counts(){return (await pool.query(`select (select count(*) from requests) requests,(select count(*) from workflow_actions) actions,(select count(*) from email_log) emails,(select coalesce(sum(last_sequence),0) from daily_counters) counters`)).rows[0]}
const payload=(formType='ERF',payments=[],editor=empty)=>({formType,payments,editor,editingIndex:-1,serviceOrderNumber:'SO-DRAFT'});
try{
  await start();
  const cookie=await login('workflow-requestor'),other=await login('workflow-ecf-only'),reviewer=await login((await pool.query("select username from employees where active and role='REVIEWER' order by email limit 1")).rows[0].username),approver=await login('workflow-approver');
  const initial=await counts();
  assert.equal((await http('/api/drafts')).status,401);
  assert.equal((await http('/api/drafts',reviewer,'POST',form(payload()))).status,403);
  assert.equal((await http('/api/drafts',other,'POST',form(payload()))).status,403);
  const created=await http('/api/drafts',cookie,'POST',form(payload('ECF',[],{...empty,purpose:'Incomplete receipt'}),null,'editor'));
  assert.equal(created.status,201,JSON.stringify(created.data));
  const draft=created.data,id=draft.id;
  assert.equal((await http(`/api/drafts/${id}`,other)).status,404);
  assert.equal((await http(draft.files[0].url,other)).status,404);
  assert.deepEqual((await http(draft.files[0].url,cookie)).data,proof);
  assert.equal((await http(`/api/drafts/${id}/submit`,cookie,'POST',{version:1})).status,400);
  assert.deepEqual(await counts(),initial,'Saving/reading incomplete drafts must not create workflow, email, or reference numbers.');
  await stop();await start();
  assert.equal((await http(`/api/drafts/${id}`,cookie)).data.payload.editor.purpose,'Incomplete receipt','Draft survives app recreation with the same data directory.');
  assert.deepEqual((await http(draft.files[0].url,cookie)).data,proof);
  const updated=await http(`/api/drafts/${id}`,cookie,'PUT',form(payload('ECF',[payment]),1,'payment_0'));
  assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.version,2);
  assert.equal((await http(`/api/drafts/${id}`,cookie,'PUT',form(payload('ECF'),1))).status,409);
  assert.equal((await http(`/api/drafts/${id}`,cookie,'DELETE',{version:1})).status,409);
  assert.equal((await http(`/api/drafts/${id}`,other,'PUT',form(payload('ECF'),2))).status,404);
  const beforeSubmit=await counts();
  const submitted=await Promise.all([1,2].map(()=>http(`/api/drafts/${id}/submit`,cookie,'POST',{version:2})));
  for(const result of submitted){assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.requestId,id);assert.equal(result.data.status,'PENDING_CHECK')}
  const afterSubmit=await counts();
  for(const field of ['requests','actions','emails','counters'])assert.equal(Number(afterSubmit[field])-Number(beforeSubmit[field]),1,`${field} must be written exactly once for concurrent submissions.`);
  assert(!(await http('/api/drafts',cookie)).data.drafts.some(d=>d.id===id));
  assert.equal((await http(`/api/drafts/${id}`,cookie,'DELETE',{version:2})).status,409);
  const detail=await http(`/api/requests/${id}`,cookie);assert.equal(detail.status,200);assert(detail.data.documents.packet);
  assert.equal((await http(`/api/requests/${id}/approve`,approver,'POST',{decision:'APPROVE'})).status,409,'Draft submission must preserve stage order.');

  // Recovery after the request transaction commits but document generation fails.
  const recovery=(await http('/api/drafts',cookie,'POST',form(payload('ERF',[payment])))).data;
  await createExpenseRequest(await getEmployee('requestor-test@metrotech.local'),[{...payment,evidenceNames:[]}],'Asia/Jakarta','EXPENSE',{requestId:recovery.id});
  const recoveryBefore=await counts();
  assert((await http(`/api/drafts/${recovery.id}`,cookie)).data.committed);
  assert.equal((await http(`/api/drafts/${recovery.id}`,cookie,'PUT',form(payload(),1))).status,409);
  const recovered=await http(`/api/drafts/${recovery.id}/submit`,cookie,'POST',{version:1});
  assert.equal(recovered.status,200,JSON.stringify(recovered.data));
  assert.equal((await counts()).requests,recoveryBefore.requests,'Recovery must reuse the committed request.');
  assert((await http(`/api/requests/${recovery.id}`,cookie)).data.documents.packet);

  const missingEvidence=(await http('/api/drafts',cookie,'POST',form(payload('ECF',[payment])))).data;
  assert.equal((await http(`/api/drafts/${missingEvidence.id}/submit`,cookie,'POST',{version:1})).status,400);
  const rejectedBypass=(await http('/api/drafts',cookie,'POST',form(payload('ERF',[payment])))).data;
  const bypass=await http(`/api/drafts/${rejectedBypass.id}/submit`,cookie,'POST',{version:1,bypass:true,bypassReason:'Not authorized'});
  assert.equal(bypass.status,403,JSON.stringify(bypass.data));
  const beforeDelete=await counts();
  assert.equal((await http(`/api/drafts/${missingEvidence.id}`,cookie,'DELETE',{version:1})).status,200);
  assert.equal((await http(`/api/drafts/${missingEvidence.id}`,cookie)).status,404);
  assert.deepEqual(await counts(),beforeDelete);

  // Dashboard drilldowns must use the same scope as counts for every role,
  // including an unrelated ECF-only requestor and an administrator.
  const admin=(await getEmployee('admin-dev@metrotech.local'));
  await pool.query("update employees set password_hash=crypt('ci-only',gen_salt('bf',10)) where email=$1",[admin.email]);
  const adminCookie=await login(admin.username);
  for(const actor of [cookie,other,reviewer,approver,await login('workflow-checker'),adminCookie]){
    const totals=(await http('/api/ems/dashboard',actor)).data.totals;
    for(const formType of ['ERF','ECF'])for(const state of ['progress','approved']){
      const expected=totals.filter(r=>r.form_type===formType&&(state==='approved'?r.status==='APPROVED':['PENDING_CHECK','PENDING_REVIEW','PENDING_APPROVAL'].includes(r.status))).reduce((s,r)=>s+r.count,0);
      const result=await http(`/api/ems/dashboard/requests?formType=${formType}&state=${state}`,actor);
      assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.total,expected);
      assert.equal(result.data.requests.length,Math.min(50,expected));
      assert(result.data.requests.every(r=>r.form_type===formType));
      assert(!result.data.requests.some(r=>'form_pdf_path' in r||'account_number' in r),'Summary must not expose document paths or bank details.');
    }
  }
  assert.equal((await http('/api/ems/dashboard/requests?formType=ERF&state=all',cookie)).status,400);
  assert.equal((await http('/api/ems/dashboard/requests?formType=ERF&state=progress&offset=-1',cookie)).status,400);
  assert.equal((await http(`/api/requests/${id}`,adminCookie)).status,403,'Dashboard access must not grant Admin workflow detail access.');
  // Storage manifests contain no arbitrary client path and retain owner isolation.
  const store=new DraftStore(root);await assert.rejects(()=>store.read('x','../anything'),{status:404});
  console.log('DRAFTS_HTTP_SMOKE_OK');
}catch(e){console.error(e,output.slice(-3500));process.exitCode=1}
finally{await stop();await pool.end();await fs.rm(root,{recursive:true,force:true})}
