import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {PDFDocument} from 'pdf-lib';
import {upgrade,snapshot} from './upgrade-ems.js';

// Never seed, truncate, or run workflow fixtures on the caller's database.
assert.equal(process.env.CI,'true','This destructive fixture test is CI-only.');
const config={host:process.env.POSTGRES_HOST||'127.0.0.1',port:Number(process.env.POSTGRES_PORT||5432),
  user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB};
const admin=new pg.Client(config);
const client=new pg.Client({...config,database:'ems_upgrade_ci'});
let created=false,connected=false,server;
let logs='';
try{
  await admin.connect();
  await admin.query('CREATE DATABASE ems_upgrade_ci');created=true;
  await client.connect();connected=true;
  await client.query(await fs.readFile(new URL('../../tests/fixtures/production-332903b.sql',import.meta.url),'utf8'));
  await client.query(`INSERT INTO employees(email,name,employee_id,department,location,division,role,signature_file,username,password_hash)
    SELECT lower(role)||'@example.test',role,'EMP-'||role,'Operations','Jakarta','Service',role,
      '/data/signatures/legacy.png',lower(role),crypt('Legacy-Test-Password1',gen_salt('bf',4))
    FROM unnest(ARRAY['REQUESTOR','REVIEWER','APPROVER','ADMIN']) role`);
  const pdf=await PDFDocument.create();pdf.addPage([200,200]);
  const bytes=Buffer.from(await pdf.save());
  await fs.mkdir('/tmp/ems-upgrade-ci',{recursive:true});
  await fs.writeFile('/tmp/ems-upgrade-ci/approved.pdf',bytes);
  await client.query(`INSERT INTO requests(ref_no,request_date,requester_email,employee_name,employee_id,
    department,location,division,total,status,reviewer_email,approver_email,form_pdf_path,last_rejection_reason)
    SELECT 'LEGACY-'||state,'2026-09-25','requestor@example.test','Legacy User','EMP-1',
      'Operations','Jakarta','Service',123456,state,'reviewer@example.test','approver@example.test',
      '/tmp/ems-upgrade-ci/approved.pdf',CASE WHEN state='RECALLED' THEN 'Correct legacy request' ELSE '' END
    FROM unnest(ARRAY['APPROVED','RECALLED']) state`);
  await client.query(`INSERT INTO request_items(request_id,revision,line_no,category,purpose,payment_date,amount,evidence_names)
    SELECT id,1,1,'Tools','Legacy payment','2026-09-25',123456,ARRAY['original.pdf'] FROM requests;
    INSERT INTO workflow_actions(request_id,ref_no,revision,actor_email,actor_name,actor_role,action,to_status)
    SELECT id,ref_no,1,'approver@example.test','APPROVER','APPROVER',
      CASE WHEN status='APPROVED' THEN 'FINAL_APPROVED' ELSE 'APPROVAL_RECALLED' END,status FROM requests;
    INSERT INTO email_log(request_id,ref_no,event,mail_to,status)
      SELECT id,ref_no,'SUBMITTED','reviewer@example.test','SENT' FROM requests;
    INSERT INTO daily_counters VALUES('2026-09-25','EXPENSE',7);
    INSERT INTO app_settings(key,value) VALUES('smtp_enabled','false'),('local_login_enabled','true'),('cookie_secure','false');
    INSERT INTO app_settings(key,value,is_secret) VALUES('smtp_pass',
      encode(pgp_sym_encrypt('legacy-smtp-secret','upgrade-ci-key'),'base64'),true)`);
  const before=await snapshot(client);
  assert.equal((await upgrade(client,{dryRun:true})).result,'UPGRADE_DRY_RUN_OK');
  assert.deepEqual(await snapshot(client),before);
  assert.equal((await client.query("SELECT to_regclass('ecf_details') AS name")).rows[0].name,null);
  // Force a mid-migration DDL collision and prove the earlier DDL/data rolls back.
  await client.query('CREATE TABLE admin_ecf_roles(dummy text)');
  await assert.rejects(upgrade(client));
  assert.deepEqual(await snapshot(client),before);
  assert.equal((await client.query("SELECT to_regclass('ecf_details') AS name")).rows[0].name,null);
  await client.query('DROP TABLE admin_ecf_roles');
  const result=await upgrade(client);
  assert.equal(result.result,'UPGRADE_COMMITTED');
  assert.deepEqual(await snapshot(client),before);
  await assert.rejects(upgrade(client),/Unsupported or already migrated/);
  assert.deepEqual(await snapshot(client),before);
  assert.equal((await client.query("SELECT count(*)::int n FROM employees WHERE password_hash=crypt('Legacy-Test-Password1',password_hash)")).rows[0].n,4);
  assert.equal((await client.query("SELECT pgp_sym_decrypt(decode(value,'base64'),'upgrade-ci-key') secret FROM app_settings WHERE key='smtp_pass'")).rows[0].secret,'legacy-smtp-secret');

  server=spawn(process.execPath,['--import','./src/ecf-profile-preload.js','src/server.js'],{
    env:{...process.env,POSTGRES_DB:'ems_upgrade_ci',APP_CONFIG_MASTER_KEY:'upgrade-ci-key',
      PORT:'18990',PDF_DIR:'/tmp/ems-upgrade-ci',PDF_MODE:'mock',MAIL_GATEWAY_URL:'',MAIL_GATEWAY_SECRET:''},
    stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
  const base='http://127.0.0.1:18990';let ready=false;
  for(let i=0;i<60;i++){
    try{ready=(await fetch(base+'/health')).ok}catch{}
    if(ready)break;
    if(server.exitCode!==null)throw new Error('Upgraded app exited: '+logs);
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert(ready,'Upgraded app must start: '+logs);
  const records=(await client.query('SELECT id,status FROM requests')).rows;
  for(const username of ['requestor','reviewer','approver','admin']){
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,password:'Legacy-Test-Password1'})});
    // Match the browser: consume the complete login response before the next
    // request. Headers can arrive while express-session is still saving it.
    const loginBody=await login.json();
    assert.equal(login.status,200,`Legacy ${username} login`);
    assert.equal(loginBody.ok,true);
    const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
    const me=await fetch(base+'/api/me',{headers});assert.equal(me.status,200);
    if(username==='admin')continue;
    for(const row of records){
      const response=await fetch(base+`/api/requests/${row.id}`,{headers});assert.equal(response.status,200);
      const detail=await response.json();assert.equal(detail.request.status,row.status);
      assert.equal(detail.items.length,1);assert.equal(detail.actions.length,1);
      if(row.status==='APPROVED'){
        const download=await fetch(base+`/api/requests/${row.id}/form/download`,{headers});
        assert.equal(download.status,200);assert(bytes.equals(Buffer.from(await download.arrayBuffer())));
      }
    }
  }
  console.log('PRODUCTION_UPGRADE_SMOKE_OK: rollback, credentials, legacy records, settings, PDF and login preserved');
}finally{
  if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve))}
  if(connected)await client.end();
  if(created)await admin.query('DROP DATABASE ems_upgrade_ci WITH (FORCE)');
  await admin.end();
}
