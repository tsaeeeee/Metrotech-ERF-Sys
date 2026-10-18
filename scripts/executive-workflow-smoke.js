import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {upgrade,snapshot} from './release-executive/upgrade.js';
import {canBypass,takeoverRole} from '../src/access.js';

assert.equal(process.env.CI,'true','Run only in CI; creates and deletes a dedicated fixture database.');
const database='ems_executive_ci';
const admin=new pg.Client({host:process.env.POSTGRES_HOST,port:process.env.POSTGRES_PORT,
  user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'ems-executive-ci-'));
const captured=[];
const gateway=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  captured.push(JSON.parse(body));res.setHeader('content-type','application/json');res.end('{"ok":true}');
});
await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
Object.assign(process.env,{POSTGRES_DB:database,PDF_DIR:temp,PDF_MODE:'mock',PORT:'18995',
  MAIL_GATEWAY_URL:`http://127.0.0.1:${gateway.address().port}`,MAIL_GATEWAY_SECRET:'ci-only'});
const origin='http://127.0.0.1:18995';
let created=false,app,pool,lockPool,logs='';
try{
  await admin.connect();await admin.query(`create database ${database}`);created=true;
  const db=await import('../src/db.js');pool=db.pool;lockPool=db.workflowLockPool;
  const schema=await fs.readFile(new URL('../sql/schema.sql',import.meta.url),'utf8');
  await pool.query(schema.slice(0,schema.indexOf('-- Existing permissions, assignments, notes and transactions remain unchanged.')));
  await pool.query(`insert into employees(email,name,employee_id,department,location,division,role,username,password_hash,signature_file)
    select x||'@example.test',x,x,'Ops','Jakarta','Service',r,x,crypt('ci-only',gen_salt('bf',10)),'/tmp/ci.png'
    from (values ('LegacyUser','REQUESTOR'),('LegacyReviewer','REVIEWER'),('LegacyOwner','APPROVER')) as e(x,r)`);
  await pool.query(`insert into requests(ref_no,request_date,requester_email,employee_name,employee_id,department,location,division,total,status,reviewer_email,approver_email)
    values('ERF-LEGACY','2026-10-01','LegacyUser@example.test','LegacyUser','001','Ops','Jakarta','Service',12345,'APPROVED','LegacyReviewer@example.test','LegacyOwner@example.test')`);
  await pool.query(`insert into request_items(request_id,revision,line_no,category,purpose,payment_date,amount)
    select id,revision,1,'Legacy','Preserve this transaction',request_date,total from requests`);
  await pool.query(`insert into workflow_actions(request_id,ref_no,revision,actor_email,actor_name,actor_role,action,to_status,reason)
    select id,ref_no,revision,approver_email,'LegacyOwner','APPROVER','FINAL_APPROVED','APPROVED','Existing audit' from requests`);
  const client=await pool.connect();
  try{
    const before=await snapshot(client);
    assert.equal((await upgrade(client,{dryRun:true})).result,'EXECUTIVE_WORKFLOW_DRY_RUN_OK');
    assert.equal((await client.query("select count(*)::int n from information_schema.columns where table_name='employees' and column_name='workflow_options'")).rows[0].n,0);
    await upgrade(client);await upgrade(client);
    assert.deepEqual(await snapshot(client),before);
    assert.equal((await client.query("select workflow_plan from requests where ref_no='ERF-LEGACY'")).rows[0].workflow_plan,null);
  }finally{client.release()}
  const legacy=await db.getRequestDetail((await pool.query("select id from requests where ref_no='ERF-LEGACY'")).rows[0].id);
  assert.equal(legacy.actions[0].reason,'Existing audit');
  await pool.query("update employees set active=false where email like 'Legacy%'");
  const full={ERF:['REQUESTOR','REVIEWER','APPROVER'],ECF:['REQUESTOR','CHECKER','REVIEWER','APPROVER']};
  const primary={ERF:['REQUESTOR','REVIEWER'],ECF:['REQUESTOR','REVIEWER']};
  const data=(name,roles,options)=>({name,email:name.toLowerCase()+'@example.test',username:name.toLowerCase(),password:'ci-only',
    employeeId:name,department:'Ops',location:'Jakarta',division:'Service',role:'NONE',workflowRoles:roles,workflowOptions:options});
  const ownOptions={ERF:{review:'SECONDARY',bypass:true},ECF:{review:'SECONDARY',check:'SECONDARY',bypass:true}};
  const owner=await db.createManagedEmployee(data('Owner',full,ownOptions));
  const dimas=await db.createManagedEmployee(data('Dimas',primary,{displayName:'Dimas',ERF:{review:'PRIMARY'},ECF:{review:'PRIMARY'}}));
  const rizal=await db.createManagedEmployee(data('Rizal',primary,{displayName:'Rizal',ERF:{review:'PRIMARY'},ECF:{review:'PRIMARY'}}));
  const kilat=await db.createManagedEmployee(data('Kilat',{ERF:['REQUESTOR'],ECF:['REQUESTOR','CHECKER']}));
  const user=await db.createManagedEmployee(data('User',{ERF:['REQUESTOR'],ECF:['REQUESTOR']}));
  const outsider=await db.createManagedEmployee(data('Outsider',{ERF:['REVIEWER'],ECF:['CHECKER','REVIEWER']},{ECF:{check:'PRIMARY'}}));
  // The unrelated checker is inactive; Kilat is the only ordinary Checker.
  await pool.query('update employees set active=false where email=$1',[outsider.email]);
  await pool.query("update employees set signature_file='/tmp/ci.png',must_change_password=false,must_upload_signature=false");
  await pool.query(`insert into employee_payment_profiles(employee_email,payment_to,bank_name,bank_code,account_number)
    select email,name,'Bank Central Asia','BCA','123456789' from employees`);
  await assert.rejects(db.createManagedEmployee(data('AnotherOwner',full,ownOptions)),e=>e.status===409);
  await assert.rejects(db.updateManagedEmployee(user.email,{...data('User',{ERF:['REQUESTOR'],ECF:['REQUESTOR']},ownOptions),password:''}),e=>e.status===400);
  assert(canBypass(owner,'ERF'));assert(!canBypass(user,'ERF'));
  const items=[{category:'Transportation',purpose:'Executive workflow fixture',paymentDate:'2026-10-17',amount:10000,evidenceNames:[]}];
  const create=(actor=user,options={})=>db.createExpenseRequest(actor,items,'Asia/Jakarta','EXPENSE',options);
  const decide=(r,actor,stage,decision='APPROVE',note='')=>db.transitionRequest(r.id,actor,stage,decision,note,r.revision);
  const task=async(actor,id)=>(await db.listTasksForEmployee(actor)).some(r=>r.id===id);
  const shared=await create();
  assert.deepEqual(shared.workflow_plan.reviewers.map(e=>e.email),[dimas.email,rizal.email]);
  assert(await task(dimas,shared.id));assert(await task(rizal,shared.id));assert(!await task(owner,shared.id));
  for(const actor of [user,dimas,rizal,owner])assert((await db.listDecisionHistory(actor)).some(r=>r.id===shared.id));
  assert(!(await db.listDecisionHistory(outsider)).some(r=>r.id===shared.id));
  assert.equal((await db.getRequestDetail(shared.id)).request.reviewer_name,'Dimas/Rizal');
  await assert.rejects(decide(shared,owner,'REVIEW'),e=>e.status===403);
  // Concurrent conflicting decisions commit exactly once; never overwrite the winner.
  const race=await Promise.allSettled([decide(shared,dimas,'REVIEW','APPROVE','Approved note'),decide(shared,rizal,'REVIEW','REJECT','Rejected note')]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  const raced=await db.getRequestDetail(shared.id);
  const decisions=raced.actions.filter(a=>['REVIEW_APPROVED','REVIEW_REJECTED'].includes(a.action));
  assert.equal(decisions.length,1);assert.equal(raced.request.reviewer_email,decisions[0].actor_email);
  assert(decisions[0].reason);assert(!await task(dimas,shared.id));assert(!await task(rizal,shared.id));
  const ownReview=await create(dimas);
  assert.deepEqual(ownReview.workflow_plan.reviewers.map(e=>e.email),[rizal.email]);
  await assert.rejects(decide(ownReview,dimas,'REVIEW'),e=>e.status===403);
  const normalOwner=await create(owner);
  await assert.rejects(decide(normalOwner,owner,'APPROVAL'),e=>[403,409].includes(e.status));
  await decide(normalOwner,dimas,'REVIEW');await decide(normalOwner,owner,'APPROVAL');
  await assert.rejects(create(user,{bypass:true,bypassReason:'Spoof'}),e=>e.status===403);
  await assert.rejects(create(owner,{bypass:true}),e=>e.status===400);
  const bypass=await create(owner,{bypass:true,bypassReason:'Executive direct approval'});
  assert.equal(bypass.status,'PENDING_APPROVAL');assert.equal(bypass.reviewer_email,null);
  assert(await task(owner,bypass.id));assert(!await task(dimas,bypass.id));
  await decide(bypass,owner,'APPROVAL','APPROVE','Owner note');
  const bd=await db.getRequestDetail(bypass.id);
  assert(bd.actions.some(a=>a.action==='EXECUTIVE_BYPASS'&&a.reason==='Executive direct approval'));
  assert.equal(bd.request.reviewer_signature,null);
  assert.equal(bd.request.reviewer_name,'Bypassed by executive');
  // Status alone, or a fabricated plan without bypass audit, cannot authorize self-approval.
  const forged=await create(owner);
  await pool.query("update requests set status='PENDING_APPROVAL',workflow_plan=jsonb_set(workflow_plan,'{bypass}','true') where id=$1",[forged.id]);
  await assert.rejects(decide(forged,owner,'APPROVAL'),e=>e.status===409);
  const takeover=await create();
  assert.equal(takeoverRole(owner,takeover),'REVIEWER');
  await assert.rejects(db.takeOverRequest(takeover.id,owner,'',1),e=>e.status===400);
  await assert.rejects(db.takeOverRequest(takeover.id,owner,'Manual assistance',0),e=>e.status===409);
  await assert.rejects(db.takeOverRequest(takeover.id,rizal,'Unauthorized',1),e=>e.status===409);
  const taken=await db.takeOverRequest(takeover.id,owner,'Manual assistance',1);
  assert.equal(taken.status,'PENDING_REVIEW');assert.equal(taken.reviewer_email,owner.email);
  assert(await task(owner,takeover.id));assert(!await task(dimas,takeover.id));
  await assert.rejects(decide(taken,dimas,'REVIEW'),e=>e.status===403);
  await decide(taken,owner,'REVIEW');
  const claim=await db.createEcfClaim(user,items);
  assert.equal((await db.getRequestDetail(claim.id)).request.checker_email,kilat.email);
  assert(!await task(dimas,claim.id));assert(!await task(owner,claim.id));
  for(const actor of [user,kilat,dimas,rizal,owner])assert((await db.listDecisionHistory(actor)).some(r=>r.id===claim.id));
  await decide(claim,kilat,'CHECK','APPROVE','Receipt checked');
  await decide(claim,rizal,'REVIEW','APPROVE','<img src=x onerror=alert(1)> review note');
  await decide(claim,owner,'APPROVAL','APPROVE','Final note');
  const approved=await db.getRequestDetail(claim.id);
  assert.equal(approved.request.reviewer_name,'Rizal');
  assert.deepEqual(approved.request.decision_notes.map(a=>a.actor_role),['CHECKER','REVIEWER','APPROVER']);
  const {saveAppSettings}=await import('../src/settings.js');
  const {sendWorkflowMail}=await import('../src/mailer.js');
  await saveAppSettings({localLoginEnabled:true,cookieSecure:false,smtpEnabled:false},owner.email);
  await sendWorkflowMail({event:'FINAL_APPROVED',request:approved.request,to:user.email,subject:'Fixture',text:'Approved'});
  const mail=captured.at(-1);
  for(const note of ['Receipt checked','review note','Final note'])assert(mail.text.includes(note)&&mail.html.includes(note));
  assert(mail.html.includes('&lt;img'));assert(!mail.html.includes('<img src=x'));
  for(const actor of [kilat,dimas,rizal,owner])assert(mail.cc.includes(actor.email));
  // Checker cannot check their own claim: it stays visible until an explicit executive takeover.
  const ownClaim=await db.createEcfClaim(kilat,items);
  assert.equal((await db.getRequestDetail(ownClaim.id)).request.checker_email,null);
  await assert.rejects(decide(ownClaim,kilat,'CHECK'),e=>e.status===403);
  await assert.rejects(db.updateManagedEmployee(owner.email,{...data('Owner',full,{...ownOptions,ECF:{...ownOptions.ECF,check:'PRIMARY'}}),password:''}),e=>e.status===409);
  await assert.rejects(db.updateManagedEmployee(owner.email,{...data('Owner',{...full,ECF:['REQUESTOR','REVIEWER','APPROVER']},{...ownOptions,ECF:{...ownOptions.ECF,check:'PRIMARY'}}),password:''}),e=>e.status===409);
  await db.takeOverRequest(ownClaim.id,owner,'Independent check for requester',1);
  await decide(ownClaim,owner,'CHECK');assert(await task(dimas,ownClaim.id));
  await pool.query('update employees set active=false where email=any($1::text[])',[[dimas.email,rizal.email]]);
  const unavailable=await create();
  assert.equal(unavailable.reviewer_email,null);assert(!await task(owner,unavailable.id));
  await assert.rejects(db.updateManagedEmployee(owner.email,{...data('Owner',full,{...ownOptions,ERF:{...ownOptions.ERF,review:'ASSIGNED'}}),password:''}),e=>e.status===409);
  await db.takeOverRequest(unavailable.id,owner,'Primary reviewers unavailable',1);
  await decide(unavailable,owner,'REVIEW');
  await pool.query('update employees set active=true where email=any($1::text[])',[[dimas.email,rizal.email]]);
  const ownBypassClaim=await db.createEcfClaim(owner,items,'Asia/Jakarta','',{bypass:true,bypassReason:'Executive claim'});
  assert.equal(ownBypassClaim.status,'PENDING_APPROVAL');
  await decide(ownBypassClaim,owner,'APPROVAL');
  const bypassClaimDetail=await db.getRequestDetail(ownBypassClaim.id);
  assert.equal(bypassClaimDetail.request.checker_signature,null);
  const {buildFormPdf}=await import('../src/documents.js');
  const pdfFile=path.join(temp,'bypass.pdf');
  await buildFormPdf({...bypassClaimDetail,outPath:pdfFile});
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf=await getDocument({data:new Uint8Array(await fs.readFile(pdfFile)),useSystemFonts:true}).promise;
  const pdfText=(await (await pdf.getPage(1)).getTextContent()).items.map(x=>x.str).join(' ');
  assert.equal(pdfText.match(/Bypassed by executive/g)?.length,2);await pdf.destroy();
  const revise=await create();
  await decide(revise,dimas,'REVIEW','REJECT','OLD REVISION NOTE');
  const revised=await db.reviseExpenseRequest(revise.id,user,items);
  await assert.rejects(decide(revise,rizal,'REVIEW'),e=>e.status===409);
  assert.equal((await db.getRequestDetail(revise.id)).request.decision_notes.length,0);
  await decide(revised,rizal,'REVIEW','APPROVE','CURRENT REVISION NOTE');
  const rd=await db.getRequestDetail(revise.id);
  await sendWorkflowMail({event:'REVIEW_APPROVED',request:rd.request,to:owner.email,text:'Reviewed'});
  assert(!captured.at(-1).text.includes('OLD REVISION NOTE'));assert(captured.at(-1).text.includes('CURRENT REVISION NOTE'));
  await assert.rejects(decide(revised,owner,'APPROVAL','REJECT','  '),e=>e.status===400);

  // Exercise actual HTTP locking, document regeneration and mail fanout together.
  app=spawn(process.execPath,['--import','./src/ecf-profile-preload.js','src/server.js'],{env:process.env,stdio:['ignore','pipe','pipe']});
  app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x);
  let ready=false;for(let i=0;i<80;i++){try{ready=(await fetch(origin+'/health')).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,150))}
  assert(ready,logs);
  const login=async username=>{
    const r=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'ci-only'})});
    assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];
  };
  const dc=await login('dimas'),rc=await login('rizal'),oc=await login('owner');
  const httpReq=await create();
  const post=(id,suffix,cookie,body)=>fetch(`${origin}/api/requests/${id}/${suffix}`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
  const beforeMail=captured.length;
  const responses=await Promise.all([dc,rc].map(cookie=>post(httpReq.id,'review',cookie,{decision:'APPROVE',reason:'HTTP approval note',revision:1})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal(captured.length,beforeMail+1);assert(captured.at(-1).text.includes('HTTP approval note'));
  const hd=await db.getRequestDetail(httpReq.id);
  assert(hd.request.form_pdf_path);assert.equal(hd.actions.filter(a=>a.action==='REVIEW_APPROVED').length,1);
  const manual=await create();
  assert.equal((await post(manual.id,'takeover',oc,{reason:'HTTP takeover',revision:1})).status,200);
  assert.equal((await db.getRequestDetail(manual.id)).request.status,'PENDING_REVIEW');
  assert.equal((await post(manual.id,'review',oc,{decision:'APPROVE',reason:'Executive review',revision:1})).status,200);
  assert.equal((await post(manual.id,'approve',oc,{decision:'APPROVE',reason:'Executive final',revision:1})).status,200);
  console.log('EXECUTIVE_WORKFLOW_SMOKE_OK: preservation, roles, concurrency, bypass, takeover, notes, PDF, HTTP and local mail');
}catch(e){console.error(logs);throw e}
finally{
  if(app&&app.exitCode===null&&app.signalCode===null){const end=new Promise(r=>app.once('close',r));app.kill('SIGKILL');await end}
  if(lockPool)await lockPool.end();if(pool)await pool.end();
  await new Promise(r=>gateway.close(r));
  if(created)await admin.query(`drop database ${database}`);await admin.end();
  await fs.rm(temp,{recursive:true,force:true});
}
