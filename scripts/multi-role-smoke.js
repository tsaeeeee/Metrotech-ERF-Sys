import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import pg from 'pg';
import {spawn} from 'node:child_process';
import {hasRole,assignedRole,recallRole,normalizeWorkflowRoles} from '../src/access.js';

assert.equal(process.env.CI,'true','Run only in CI; creates and deletes a dedicated fixture database.');
const originalDb=process.env.POSTGRES_DB;
const adminDb=new pg.Client({host:process.env.POSTGRES_HOST,port:process.env.POSTGRES_PORT,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:originalDb});
const database='ems_multirole_ci';
let created=false,app,pool,lockPool,logs='';
const captured=[];
const gateway=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  captured.push(JSON.parse(body));res.setHeader('content-type','application/json');res.end('{"ok":true}');
});
await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
process.env.MAIL_GATEWAY_URL=`http://127.0.0.1:${gateway.address().port}`;
process.env.MAIL_GATEWAY_SECRET='ci-only';
process.env.POSTGRES_DB=database;
process.env.PDF_DIR='/tmp/ems-multirole-ci';
process.env.PDF_MODE='mock';
process.env.PORT='18996';
const origin='http://127.0.0.1:18996';
try{
  await adminDb.connect();await adminDb.query(`CREATE DATABASE ${database}`);created=true;
  const db=await import('../src/db.js');pool=db.pool;lockPool=db.workflowLockPool;
  await pool.query(await fs.readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
  // Startup creates an admin only when absent; existing identity/security flags stay intact.
  await db.ensureBootstrapAdminCredentials();
  await pool.query("update employees set name='Existing Owner Admin',department='Custom',active=false,username='renamed-admin' where role='ADMIN'");
  const adminBefore=(await pool.query("select to_jsonb(e) as row from employees e where role='ADMIN'")).rows;
  await db.ensureBootstrapAdminCredentials();await db.ensureBootstrapAdminCredentials();
  assert.deepEqual((await pool.query("select to_jsonb(e) as row from employees e where role='ADMIN'")).rows,adminBefore);
  const before=(await pool.query("select coalesce(jsonb_agg(to_jsonb(e)-'workflow_roles'),'[]') as data from employees e")).rows[0].data;
  const migration=await fs.readFile(new URL('../sql/migrations/018-assigned-multi-role.sql',import.meta.url),'utf8');
  await pool.query(migration);await pool.query(migration);
  assert.deepEqual((await pool.query("select coalesce(jsonb_agg(to_jsonb(e)-'workflow_roles'),'[]') as data from employees e")).rows[0].data,before);
  assert.equal((await fs.readFile(new URL('../public/workflow-access.js',import.meta.url),'utf8')).split('\n').slice(1).join('\n'),(await fs.readFile(new URL('../src/access.js',import.meta.url),'utf8')).replaceAll('export ',''));
  assert.throws(()=>normalizeWorkflowRoles({ERF:['ADMIN'],ECF:[]}));
  const userData=(name,role,workflowRoles)=>({name,email:name.toLowerCase()+'@example.test',username:name.toLowerCase(),password:'ci-only',employeeId:name,department:'Ops',location:'Jakarta',division:'Service',role,workflowRoles});
  const full={ERF:['REQUESTOR','REVIEWER','APPROVER'],ECF:['REQUESTOR','CHECKER','REVIEWER','APPROVER']};
  const owner=await db.createManagedEmployee(userData('Owner','APPROVER',full));
  const reviewer=await db.createManagedEmployee(userData('Reviewer','REVIEWER'));
  const requester=await db.createManagedEmployee(userData('Requester','REQUESTOR'));
  const outsider=await db.createManagedEmployee(userData('Unassigned','NONE',{ERF:['REVIEWER'],ECF:['CHECKER','REVIEWER']}));
  const ownerHash=(await pool.query('select password_hash from employees where email=$1',[owner.email])).rows[0].password_hash;
  await db.updateManagedEmployee(owner.email,{...userData('Owner','APPROVER',full),password:''});
  assert.equal((await pool.query('select password_hash from employees where email=$1',[owner.email])).rows[0].password_hash,ownerHash);
  await assert.rejects(db.createManagedEmployee(userData('Second','NONE',{ERF:[],ECF:['APPROVER']})),e=>e.status===409);
  // Concurrent grants cannot create a second approver either.
  await assert.rejects(db.updateManagedEmployee(outsider.email,{...userData('Unassigned','NONE',{ERF:['APPROVER'],ECF:[]}),password:''}),e=>e.status===409);
  const items=[{category:'Transportation',purpose:'Multi-role regression',paymentDate:'2026-10-09',amount:10000,evidenceNames:[]}];
  await pool.query(`insert into employee_payment_profiles(employee_email,payment_to,bank_name,bank_code,account_number)
    select email,name,'Bank Central Asia','BCA','123456789' from employees`);
  await pool.query("update employees set must_change_password=false,must_upload_signature=false,signature_file='/tmp/ci-signature.png'");
  let selfErf=await db.createExpenseRequest(owner,items);
  assert.equal(selfErf.approver_email,owner.email);assert.notEqual(selfErf.reviewer_email,owner.email);
  await assert.rejects(db.transitionRequest(selfErf.id,owner,'REVIEW','APPROVE'),e=>e.status===403);
  await assert.rejects(db.transitionRequest(selfErf.id,owner,'APPROVAL','APPROVE'),e=>[403,409].includes(e.status));
  await db.transitionRequest(selfErf.id,await db.getEmployee(selfErf.reviewer_email),'REVIEW','APPROVE');
  assert((await db.listTasksForEmployee(owner)).some(r=>r.id===selfErf.id&&r.task_role==='APPROVER'));
  await db.transitionRequest(selfErf.id,owner,'APPROVAL','APPROVE');
  const selfDetail=await db.getRequestDetail(selfErf.id);
  assert(selfDetail.actions.some(a=>a.action==='SUBMITTED'&&a.actor_role==='REQUESTOR'));
  assert(selfDetail.actions.some(a=>a.action==='FINAL_APPROVED'&&a.actor_role==='APPROVER'));
  assert.equal(recallRole(owner,selfDetail.request),'APPROVER');
  const other=await db.createExpenseRequest(requester,items);
  await assert.rejects(db.transitionRequest(other.id,{...owner,email:outsider.email},'REVIEW','APPROVE'),e=>e.status===403);
  await assert.rejects(db.updateManagedEmployee(owner.email,{...userData('Owner','APPROVER',{ERF:['REQUESTOR'],ECF:full.ECF}),password:''}),e=>e.status===409);
  // Own ECF is always independently checked and reviewed, then returns to its sole Approver.
  const selfEcf=await db.createEcfClaim(owner,items);
  const ownClaim=await db.getRequestDetail(selfEcf.id);
  assert.notEqual(ownClaim.request.checker_email,owner.email);
  assert.notEqual(selfEcf.reviewer_email,owner.email);
  await assert.rejects(db.transitionRequest(selfEcf.id,owner,'CHECK','APPROVE'),e=>e.status===403);
  await db.transitionRequest(selfEcf.id,await db.getEmployee(ownClaim.request.checker_email),'CHECK','APPROVE');
  await db.transitionRequest(selfEcf.id,await db.getEmployee(selfEcf.reviewer_email),'REVIEW','APPROVE');
  await db.transitionRequest(selfEcf.id,owner,'APPROVAL','APPROVE');
  assert((await db.listMyRequests(owner)).some(r=>r.id===selfEcf.id));
  assert((await db.listDecisionHistory(owner)).some(r=>r.id===selfEcf.id));
  assert(!(await db.listTasksForEmployee(owner)).some(r=>r.id===selfEcf.id));
  assert.equal(assignedRole(owner,{...ownClaim.request,status:'PENDING_APPROVAL'}),'APPROVER');
  assert(hasRole(owner,'ECF','REQUESTOR')&&hasRole(owner,'ECF','CHECKER'));
  // No implicit Checker takeover: another permitted checker cannot act on this assignment.
  const claim=await db.createEcfClaim(requester,items);
  const cd=await db.getRequestDetail(claim.id);
  const wrong=cd.request.checker_email===owner.email?outsider:owner;
  await assert.rejects(db.transitionRequest(claim.id,wrong,'CHECK','APPROVE'),e=>e.status===403);
  assert(!(await db.listTasksForEmployee(wrong)).some(r=>r.id===claim.id&&r.task_role==='CHECKER'));
  // Stage spoofing without actual independent decisions must never authorize owner self-approval.
  const forged=await db.createExpenseRequest(owner,items);
  await pool.query("update requests set status='PENDING_APPROVAL' where id=$1",[forged.id]);
  await assert.rejects(db.transitionRequest(forged.id,owner,'APPROVAL','APPROVE'),e=>e.status===409);
  // Transport-level check includes the assigned approver, preserving other recipients without duplication.
  const {sendWorkflowMail}=await import('../src/mailer.js');
  const {saveAppSettings}=await import('../src/settings.js');
  await saveAppSettings({localLoginEnabled:true,cookieSecure:false,smtpEnabled:false},owner.email);
  await sendWorkflowMail({event:'APPROVAL_RECALLED',request:{...selfDetail.request},to:owner.email,cc:[reviewer.email,owner.email,owner.email.toUpperCase()],text:'Recall',subject:'Test'});
  assert.equal(captured.at(-1).to,owner.email);
  assert.equal(captured.at(-1).cc,reviewer.email);
  // HTTP authorization uses the same account's module roles, not its primary role.
  await pool.query("update employees set must_change_password=false,must_upload_signature=false,signature_file='/tmp/ci-signature.png'");
  app=spawn(process.execPath,['--import','./src/ecf-profile-preload.js','src/server.js'],{env:process.env,stdio:['ignore','pipe','pipe']});
  app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x);
  let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch(origin+'/health')).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,150))}
  assert(ready,logs);
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'ci-only'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const me=await (await fetch(origin+'/api/me',{headers:{cookie}})).json();
  assert.deepEqual(me.employee.workflow_roles,full);
  assert(me.myRequests.some(r=>r.id===selfErf.id));
  const denied=await fetch(origin+`/api/requests/${claim.id}/check`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"decision":"APPROVE"}'});
  if(cd.request.checker_email!==owner.email)assert.equal(denied.status,403);
  assert.equal((await fetch(origin+'/api/admin/users',{headers:{cookie}})).status,403,'Multi-role must not grant Admin.');
  console.log('MULTI_ROLE_SMOKE_OK');
}finally{
  if(app&&app.exitCode===null&&app.signalCode===null){
    const closed=new Promise(resolve=>app.once('close',resolve));app.kill('SIGKILL');await closed;
  }
  if(lockPool)await lockPool.end();
  if(pool)await pool.end();await new Promise(resolve=>gateway.close(resolve));
  if(created)await adminDb.query(`DROP DATABASE ${database}`);await adminDb.end();
}
