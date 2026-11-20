import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {digest,inspectSnapshot} from '../src/cash-model.js';
import {importCashSnapshot} from '../src/cash.js';
import {upgrade} from './release-cash/upgrade.js';
import {captureSnapshot} from './cash-snapshot.js';
import {backupCash,backupRequests} from '../src/cash-sheets.js';

assert.equal(process.env.CI,'true','This test creates and deletes an isolated fixture database.');
const database='ems_cash_ci';
const admin=new pg.Client({host:process.env.POSTGRES_HOST,port:process.env.POSTGRES_PORT,user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB});
const root=await fs.mkdtemp(path.join(os.tmpdir(),'ems-cash-ci-'));
Object.assign(process.env,{POSTGRES_DB:database,PDF_DIR:root,PDF_MODE:'mock',PORT:'18989',EMS_STAGING:'true',EMS_STAGE_SESSION_SECRET:'cash-test-session-only',MAIL_GATEWAY_URL:'',MAIL_GATEWAY_SECRET:'',CASH_GOOGLE_KEY_FILE:''});
let pool,lockPool,server,created=false,logs='';
const origin='http://127.0.0.1:18989';
async function http(url,cookie,method='GET',body){
  const response=await fetch(origin+url,{method,headers:{...(cookie?{cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],cache:response.headers.get('cache-control')};
}
async function login(username){const r=await http('/api/login',null,'POST',{username,password:'ci-only'});assert.equal(r.status,200,JSON.stringify(r.data));return r.cookie}
const fixture={format:'ems-cash-snapshot-v1',spreadsheetId:'fixture_cash_workbook_123456',capturedAt:'2026-11-19T00:00:00.000Z',sheets:[
  {sheetId:0,title:'2025',rows:[{row:1,values:['DATE','CATEGORY','ACTIVITY','INCOME','OUTCOME','','CURRENT BALANCE',794.91]},
    {row:2,values:['2025-01-01','Cash Deposit','Carryover 2024 to 2025',1000.01,'-']},
    {row:3,values:['2025-01-02','Bank Action','Adjustment',0.16,5.26]},
    {row:4,values:['2025-01-03','Tools','',0,100]},
    {row:5,values:['2025-01-03','Tools','',0,100]}]},
  {sheetId:1,title:'2026',rows:[{row:1,values:['DATE','CATEGORY','ACTIVITY','INCOME','OUTCOME']},
    {row:2,values:['2026-11-18','Software & Subscription ','=1+1',0,165726],notes:'C: Source note'}]},
  {sheetId:2,title:'Summary',rows:[]}
]};
const upload=s=>{const f=new FormData();f.append('snapshot',new Blob([JSON.stringify(s)],{type:'application/json'}),'snapshot.json');return f};
async function existing(){
  const result={};
  const names=(await pool.query("select tablename from pg_tables where schemaname='public' and tablename not like 'cash_%' and tablename<>'session' order by tablename")).rows;
  for(const {tablename:t} of names)result[t]=(await pool.query(`select coalesce(jsonb_agg(row order by row::text),'[]') value from (select to_jsonb(x) row from "${t}" x) q`)).rows[0].value;
  return result;
}
try{
  await admin.connect();await admin.query(`create database ${database}`);created=true;
  const db=await import('../src/db.js');pool=db.pool;lockPool=db.workflowLockPool;
  const schema=await fs.readFile(new URL('../sql/schema.sql',import.meta.url),'utf8');
  await pool.query(schema.slice(0,schema.lastIndexOf('BEGIN;\nCREATE TABLE IF NOT EXISTS cash_access')));
  await db.ensureBootstrapAdminCredentials();
  await pool.query(`insert into employees(email,name,employee_id,department,location,division,role,username,password_hash,must_change_password,must_upload_signature)
    select x||'@example.test',x,x,'Ops','Jakarta','Service','NONE',x,crypt('ci-only',gen_salt('bf',4)),false,false from unnest(array['Viewer','Manager','Unassigned']) x`);
  await pool.query("update employees set password_hash=crypt('ci-only',gen_salt('bf',4)),must_change_password=false,must_upload_signature=false");
  const before=await existing();
  const migration=await fs.readFile(new URL('../sql/migrations/020-cash-tracker.sql',import.meta.url),'utf8');
  const migrationClient=await pool.connect();
  try{
    assert.equal((await upgrade(migrationClient,{dryRun:true})).result,'CASH_UPGRADE_DRY_RUN_OK');
    assert.equal((await migrationClient.query("select to_regclass('public.cash_entries') name")).rows[0].name,null);
    await upgrade(migrationClient);await upgrade(migrationClient);
  }finally{migrationClient.release()}

  assert.deepEqual(await existing(),before,'Cash migration must preserve every existing account/table value.');
  assert.equal((await pool.query('select count(*)::int n from cash_access')).rows[0].n,0,'No implicit cash grants.');
  let changedDuringCapture=false,driveReads=0;
  const readCalls=[];
  const captureClient={drive:{files:{get:async()=>({data:{modifiedTime:'2026-11-19',version:changedDuringCapture&&++driveReads%2===0?'2':'1'}})}},sheets:{spreadsheets:{get:async({ranges})=>{
    if(!ranges)return {data:{properties:{title:'Fixture'},sheets:fixture.sheets.map(s=>({properties:{sheetId:s.sheetId,title:s.title,sheetType:'GRID',gridProperties:{rowCount:450,columnCount:8}}}))}};
    readCalls.push(ranges[0]);const source=fixture.sheets.find(s=>ranges[0].startsWith("'"+s.title+"'!"));
    const start=ranges[0].includes('A401:')?400:0;
    return {data:{sheets:[{data:[{startRow:start,rowData:start?[]:source.rows.map(r=>({values:r.values.map(v=>({effectiveValue:typeof v==='number'?{numberValue:v}:{stringValue:v},userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v}}))}))}]}]}};
  }}}};
  const captured=await captureSnapshot(fixture.spreadsheetId,captureClient);assert.equal(inspectSnapshot(captured).count,5);assert.equal(readCalls.length,6,'Every sheet and trailing range must be read.');
  changedDuringCapture=true;driveReads=0;await assert.rejects(captureSnapshot(fixture.spreadsheetId,captureClient),/changed during capture/);
  const report=inspectSnapshot(fixture);assert.equal(report.count,5);assert.equal(report.sheets[0].balance,'794.91');
  assert.equal(digest({b:1,a:{d:2,c:3}}),digest({a:{c:3,d:2},b:1}),'Checksums survive JSONB key ordering.');
  assert.throws(()=>inspectSnapshot({...fixture,sheets:[...fixture.sheets,{sheetId:3,title:'Unmapped',rows:[{row:1,values:['Hidden data']}]}]}),/Unrecognized/);
  const {saveAppSettings}=await import('../src/settings.js');
  await saveAppSettings({localLoginEnabled:true,cookieSecure:false,smtpEnabled:false},'admin-dev@metrotech.local');
  server=spawn(process.execPath,['--import','./src/ecf-profile-preload.js','src/server.js'],{env:process.env,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
  let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch(origin+'/health')).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,150))}assert(ready,logs);
  const ac=await login('Administrator'),vc=await login('Viewer'),mc=await login('Manager'),nc=await login('Unassigned');
  assert.equal((await http('/api/cash/books')).status,401);
  for(const cookie of [ac,vc,mc,nc])assert.equal((await http('/api/cash/books',cookie)).status,403);
  assert.equal((await http('/api/admin/cash/access',mc)).status,403);
  for(const [email,access] of [['Viewer@example.test','VIEW'],['Manager@example.test','MANAGE']])assert.equal((await http('/api/admin/cash/access',ac,'PUT',{email,access})).status,200);
  assert.equal((await http('/api/admin/cash/access',mc,'PUT',{email:'Manager@example.test',access:'MANAGE'})).status,403);
  const stable=await existing();
  assert.equal((await http('/api/admin/cash/import/preview',mc,'POST',upload(fixture))).status,403);
  const preview=await http('/api/admin/cash/import/preview',ac,'POST',upload(fixture));assert.equal(preview.status,200,JSON.stringify(preview.data));
  assert.equal((await pool.query('select count(*)::int n from cash_entries')).rows[0].n,0);
  assert.equal((await http(`/api/admin/cash/import/${preview.data.id}/commit`,ac,'POST',{checksum:preview.data.report.checksum})).status,400);
  const commits=await Promise.all([1,2].map(()=>http(`/api/admin/cash/import/${preview.data.id}/commit`,ac,'POST',{checksum:preview.data.report.checksum,confirm:true})));
  assert(commits.every(r=>r.status===200),JSON.stringify(commits));assert.equal(commits.filter(r=>r.data.alreadyImported).length,1);
  assert.equal((await pool.query('select count(*)::int n from cash_entries')).rows[0].n,5);
  assert.equal((await pool.query('select count(*)::int n from cash_imports')).rows[0].n,1,'Preview and commit reuse the same batch despite JSONB ordering.');
  assert.deepEqual(await existing(),stable,'Import must not alter ERF, ECF, users or settings.');
  const changed=await http('/api/admin/cash/import/preview',ac,'POST',upload({...fixture,capturedAt:'2026-11-20T00:00:00.000Z'}));
  assert.equal((await http(`/api/admin/cash/import/${changed.data.id}/commit`,ac,'POST',{checksum:changed.data.report.checksum,confirm:true})).status,409);
  const books=await http('/api/cash/books',vc);assert.equal(books.status,200);assert.match(books.cache,/no-store/);assert.equal(books.data.books.length,2);
  const book=books.data.books.find(b=>b.year===2026),oldBook=books.data.books.find(b=>b.year===2025);
  const overview=await http('/api/cash/overview?book='+oldBook.id,vc);assert.equal(overview.data.totals.opening,'1000.01');assert.equal(overview.data.totals.income,'0.16');assert.equal(overview.data.totals.balance,'794.91');
  assert.equal((await http('/api/cash/overview?book='+book.id,vc)).data.totals.balance,'-165726.00','Negative balances must remain visible.');
  const entry={id:randomUUID(),book_id:book.id,entry_date:'2026-11-19',category:'Cash Deposit',activity:'Test receipt',notes:'Audit me',income:'200000.10',outcome:'0'};
  assert.equal((await http('/api/cash/entries',vc,'POST',entry)).status,403);
  assert.equal((await http('/api/cash/entries',nc,'POST',entry)).status,403);
  assert.equal((await http('/api/cash/entries',mc,'POST',{...entry,outcome:'1'})).status,400);
  assert.equal((await http('/api/cash/entries',mc,'POST',{...entry,entry_date:'2025-01-01'})).status,400);
  const saved=await Promise.all([1,2,3].map(()=>http('/api/cash/entries',mc,'POST',entry)));assert(saved.every(r=>r.status===201),JSON.stringify(saved));
  assert.equal((await pool.query("select count(*)::int n from cash_audit where entry_id=$1 and action='CREATED'",[entry.id])).rows[0].n,1);
  assert.equal((await http('/api/cash/entries',mc,'POST',{...entry,income:'200001'})).status,409);
  const filtered=await http('/api/cash/entries?'+new URLSearchParams({book:book.id,q:'Test receipt'}),vc);assert.equal(filtered.data.total,1);assert.equal(filtered.data.entries[0].balance,'34274.10','Search must not recalculate the running balance from a subset.');
  assert.equal((await http(`/api/cash/entries/${entry.id}/void`,vc,'POST',{version:1,reason:'Test'})).status,403);
  assert.equal((await http(`/api/cash/entries/${entry.id}/void`,mc,'POST',{version:1,reason:''})).status,400);
  assert.equal((await http(`/api/cash/entries/${entry.id}/void`,mc,'POST',{version:0,reason:'Correction'})).status,409);
  const voids=await Promise.all([1,2].map(()=>http(`/api/cash/entries/${entry.id}/void`,mc,'POST',{version:1,reason:'Correction'})));assert.deepEqual(voids.map(r=>r.status).sort(),[200,409]);
  assert.equal((await http(`/api/cash/entries/${entry.id}/audit`,vc)).data.audit.length,2);
  assert.equal((await http('/api/cash/log')).status,401);
  assert.equal((await http('/api/cash/log',nc)).status,403);
  assert.equal((await http('/api/cash/log',ac)).status,403);
  assert.equal((await http('/api/cash/log?offset=-1',vc)).status,400);
  const cashLog=await http('/api/cash/log',vc);
  assert.equal(cashLog.status,200);assert.match(cashLog.cache,/no-store/);
  assert.equal(cashLog.data.logs[0].action,'VOIDED');
  assert.equal(cashLog.data.logs[0].actor_name,'Manager');
  assert.equal(cashLog.data.logs[0].entry_id,entry.id);
  assert.equal(cashLog.data.logs[0].reason,'Correction');
  assert(Number.isFinite(Date.parse(cashLog.data.logs[0].created_at)));
  assert(cashLog.data.logs.some(r=>r.action==='LEGACY_IMPORTED'&&r.imported_count==='5'));
  assert(!cashLog.data.logs.some(r=>r.action==='ACCESS_CHANGED'));
  assert(!('after_data' in cashLog.data.logs[0]));
  const nextLog=await http('/api/cash/log?offset=1',mc);
  assert.equal(nextLog.data.logs[0].id,cashLog.data.logs[1].id);
  const detailLog=await http(`/api/cash/entries/${entry.id}/audit`,vc);
  assert.equal(detailLog.data.entry.creator_name,'Manager');
  assert.equal(detailLog.data.audit[0].actor_name,'Manager');

  assert.equal((await http('/api/cash/overview?book='+book.id,vc)).data.totals.balance,'-165726.00');
  const editable={...entry,id:randomUUID(),activity:'Editable cash record',income:'0.10'};
  assert.equal((await http('/api/cash/entries',mc,'POST',editable)).status,201);
  const change={activity:'Updated cash record',income:'42.02',outcome:'0.00',version:1};
  for(const cookie of [vc,nc,ac]){
    assert.equal((await http(`/api/cash/entries/${editable.id}`,cookie,'PATCH',change)).status,403);
    assert.equal((await http(`/api/cash/entries/${editable.id}`,cookie,'DELETE',{version:1,reason:'Test'})).status,403);
  }
  assert.equal((await http(`/api/cash/entries/${editable.id}`,mc,'PATCH',{...change,income:'-1'})).status,400);
  assert.equal((await http(`/api/cash/entries/${editable.id}`,mc,'PATCH',{...change,outcome:'1'})).status,400);
  const edits=await Promise.all([1,2].map(()=>http(`/api/cash/entries/${editable.id}`,mc,'PATCH',change)));
  assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
  const updatedEntry=(await http(`/api/cash/entries/${editable.id}/audit`,vc)).data;
  assert.equal(updatedEntry.entry.income,'42.02');assert.equal(updatedEntry.entry.version,2);
  assert.equal(updatedEntry.entry.created_by,'Manager@example.test');
  assert.equal(updatedEntry.audit[0].action,'UPDATED');assert.equal(updatedEntry.audit[0].before_data.income,'0.10');
  assert.equal(updatedEntry.audit[0].after_data.activity,change.activity);
  assert.equal((await http('/api/cash/overview?book='+book.id,vc)).data.totals.balance,'-165683.98');
  const updateLog=(await http('/api/cash/log',vc)).data.logs.find(r=>r.entry_id===editable.id&&r.action==='UPDATED');
  assert.equal(updateLog.before_values.income,'0.10');assert.equal(updateLog.after_values.income,'42.02');
  assert.equal((await http(`/api/cash/entries/${editable.id}`,mc,'DELETE',{version:2,reason:''})).status,400);
  assert.equal((await http(`/api/cash/entries/${editable.id}`,mc,'DELETE',{version:1,reason:'Stale'})).status,409);
  const deletes=await Promise.all([1,2].map(()=>http(`/api/cash/entries/${editable.id}`,mc,'DELETE',{version:2,reason:'Duplicate record'})));
  assert.deepEqual(deletes.map(r=>r.status).sort(),[200,409]);
  assert.equal((await http('/api/cash/entries?'+new URLSearchParams({book:book.id,q:'Updated cash record'}),vc)).data.total,0);
  assert.equal((await http('/api/cash/overview?book='+book.id,vc)).data.totals.balance,'-165726.00');
  assert.equal((await http(`/api/cash/entries/${editable.id}/audit`,vc)).data.audit[0].action,'DELETED');
  assert.equal((await http(`/api/cash/entries/${editable.id}`,mc,'PATCH',{...change,version:3})).status,409);
  assert.equal((await pool.query('select count(*)::int n from cash_entries where id=$1',[editable.id])).rows[0].n,1,'Deletion must preserve the stored record and audit.');
  // A legacy adjustment with both sides remains editable; original snapshot is immutable.
  const legacy=(await pool.query("select * from cash_entries where origin='LEGACY' and income>0 and outcome>0 limit 1")).rows[0];
  const legacyChange={activity:'Legacy adjustment clarified',income:legacy.income,outcome:legacy.outcome,version:legacy.version};
  const legacySnapshot=(await pool.query('select snapshot from cash_imports where id=$1',[legacy.import_id])).rows[0].snapshot;
  assert.equal((await http(`/api/cash/entries/${legacy.id}`,mc,'PATCH',legacyChange)).status,200);
  assert.deepEqual((await pool.query('select snapshot from cash_imports where id=$1',[legacy.import_id])).rows[0].snapshot,legacySnapshot);
  await http('/api/admin/cash/access',ac,'PUT',{email:'Manager@example.test',access:'VIEW'});
  assert.equal((await http(`/api/cash/entries/${legacy.id}`,mc,'PATCH',{...legacyChange,version:2})).status,403);
  assert.equal((await http(`/api/cash/entries/${legacy.id}`,mc,'DELETE',{version:2,reason:'No access'})).status,403);
  assert.equal((await http('/api/cash/entries',mc,'POST',{...entry,id:randomUUID()})).status,403,'Revocation applies to an already signed-in account.');
  assert.equal((await http('/api/admin/cash/backup',ac,'PUT',{spreadsheet_id:fixture.spreadsheetId,hour_wib:2,enabled:true})).status,409,'Cannot pretend backups are active without credentials.');

  // All Google writes are stubbed. Verify ownership, atomic publication, retry
  // behavior and the daily guard without sending mail or touching a live sheet.
  const legacyMeta={sheets:[{properties:{sheetId:42,title:'2026',gridProperties:{rowCount:100,columnCount:5}}}]};
  const owned={sheets:[{properties:{sheetId:99,title:'EMS Cash Books',gridProperties:{rowCount:150,columnCount:5}},developerMetadata:[{metadataKey:'metrotech_ems_cash_backup_v1',metadataValue:'EMS Cash Books'}]}]};
  const updated=backupRequests(owned,{'EMS Cash Books':[['ID'],['x']]});assert(!updated.some(r=>r.addSheet));assert.equal(updated.find(r=>r.updateCells).updateCells.range.endRowIndex,150,'Replacement must also clear stale trailing rows.');
  const collision={sheets:[{properties:{sheetId:99,title:'EMS Cash Books',gridProperties:{rowCount:100,columnCount:5}}}]};
  assert.throws(()=>backupRequests(collision,{'EMS Cash Books':[['ID'],['x']]}),e=>e.status===409);
  let batchCount=0,marker;
  const stub={spreadsheets:{get:async()=>({data:legacyMeta}),batchUpdate:async({requestBody:{requests}})=>{
    batchCount++;assert(!requests.some(r=>r.updateCells?.range.sheetId===42),'Legacy tabs must not be changed.');
    const added=requests.filter(r=>r.addSheet).map(r=>r.addSheet.properties);
    const metadataId=added.find(s=>s.title==='EMS Cash Backup').sheetId;
    marker=requests.find(r=>r.updateCells?.range.sheetId===metadataId).updateCells.rows[1].values.map(c=>c.userEnteredValue.numberValue??c.userEnteredValue.stringValue);
    const sourceString=requests.flatMap(r=>r.updateCells?.rows||[]).flatMap(r=>r.values).find(c=>c.userEnteredValue?.stringValue==='=1+1');assert(sourceString,'Formula-like activity must be exported as a string.');
    assert.equal(requests.filter(r=>r.createDeveloperMetadata).length,4);
    return {data:{}};
  },values:{get:async()=>({data:{values:[marker]}})}}};
  await pool.query('update cash_backup_settings set enabled=true,spreadsheet_id=$1,hour_wib=2',[fixture.spreadsheetId]);
  const backed=await backupCash(pool,{now:new Date('2026-11-19T20:00:00Z'),sheetsClient:stub});assert(backed.ok);assert.equal(backed.rows,7);assert.equal(batchCount,1);
  assert((await backupCash(pool,{now:new Date('2026-11-19T21:00:00Z'),sheetsClient:stub})).skipped);assert.equal(batchCount,1);
  const failed={spreadsheets:{...stub.spreadsheets,batchUpdate:async()=>{throw new Error('Provider unreachable');}}};
  await assert.rejects(backupCash(pool,{manual:true,sheetsClient:failed}),/could not be verified/);
  assert.equal((await pool.query("select count(*)::int n from cash_backups where state='FAILED'")).rows[0].n,1);
  assert((await backupCash(pool,{manual:true,sheetsClient:stub})).ok,'A failed backup must release its lock and allow retry.');
  assert.deepEqual(await existing(),stable);
  const repeated=await pool.connect();try{await upgrade(repeated)}finally{repeated.release()}
  assert.equal((await pool.query('select count(*)::int n from cash_entries')).rows[0].n,7);

  if(process.env.CASH_TEST_SNAPSHOT){
    // Optional private source check. The workbook itself is never committed.
    const source=JSON.parse(await fs.readFile(process.env.CASH_TEST_SNAPSHOT,'utf8')),expected=inspectSnapshot(source);
    const c=await pool.connect();try{await c.query('begin');const imported=await importCashSnapshot(c,source,'admin-dev@metrotech.local');assert.equal(imported.count,expected.count);const actual=(await c.query('select count(*)::int n from cash_entries where import_id=$1',[imported.id])).rows[0];assert.equal(actual.n,expected.count);await c.query('rollback');console.log(`PRIVATE_SOURCE_RECONCILED: ${expected.count} rows, ${expected.sheets.length} sheets`)}finally{c.release()}
  }
  console.log('CASH_SMOKE_OK: preservation, import reconciliation, permissions, retries, audit, balances and backup isolation');
}catch(e){console.error(logs.slice(-3000));throw e}
finally{
  if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit')}
  if(lockPool)await lockPool.end();if(pool)await pool.end();
  if(created)await admin.query(`drop database ${database}`);await admin.end();await fs.rm(root,{recursive:true,force:true});
}
