import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

// Current EMS baseline, migration 018 only. Never use the old ERF-to-EMS upgrader.
export async function snapshot(client){
  const result={};
  const tables=(await client.query("select tablename from pg_tables where schemaname='public' and tablename<>'session' order by tablename")).rows;
  for(const {tablename} of tables){
    const id='"'+tablename.replaceAll('"','""')+'"';
    const row=tablename==='employees'?"to_jsonb(t)-'workflow_roles'":'to_jsonb(t)';
    result[tablename]=(await client.query(`select count(*)::text as count,md5(coalesce(jsonb_agg(${row} order by (${row})::text)::text,'[]')) as digest from ${id} t`)).rows[0];
  }
  result.sequences=(await client.query("select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename")).rows;
  return result;
}
export async function upgrade(client,{dryRun=false}={}){
  await client.query('begin');
  try{
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='120s'");
    await client.query('select pg_advisory_xact_lock(77123001)');
    for(const name of ['employee_form_roles','employee_payment_profiles','ecf_details'])
      assert((await client.query('select to_regclass($1) as table_name',['public.'+name])).rows[0].table_name,'Expected the existing EMS schema');
    const before=await snapshot(client);
    const sql=await fs.readFile(new URL('../../sql/migrations/018-assigned-multi-role.sql',import.meta.url),'utf8');
    await client.query(sql.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,''));
    assert.equal((await client.query("select count(*)::int as n from employees where employee_has_workflow_role(email,'ERF','APPROVER') or employee_has_workflow_role(email,'ECF','APPROVER')")).rows[0].n,1,'Exactly one active Approver is required');
    assert.equal((await client.query("select count(*)::int as n from employees where employee_has_workflow_role(email,'ERF','APPROVER') and employee_has_workflow_role(email,'ECF','APPROVER')")).rows[0].n,1,'The same Approver must cover ERF and ECF');
    const {rows:[pending]}=await client.query(`select count(*)::int as invalid from requests r left join ecf_details d on d.request_id=r.id
      where r.status in ('PENDING_CHECK','PENDING_REVIEW','PENDING_APPROVAL') and (
        not employee_has_workflow_role(r.requester_email,r.form_type,'REQUESTOR') or
        not employee_has_workflow_role(r.approver_email,r.form_type,'APPROVER') or
        (r.status in ('PENDING_CHECK','PENDING_REVIEW') and (not employee_has_workflow_role(r.reviewer_email,r.form_type,'REVIEWER') or lower(r.reviewer_email)=lower(r.requester_email))) or
        (r.status='PENDING_CHECK' and (not employee_has_workflow_role(d.checker_email,'ECF','CHECKER') or lower(d.checker_email)=lower(r.requester_email))) or
        (r.status='PENDING_APPROVAL' and lower(r.approver_email)=lower(r.requester_email))
      )`);
    // Legacy self-approval in flight needs individual review, never silently reassign it.
    assert.equal(pending.invalid,0,'Pending requests need assignment review before deployment');
    assert.deepEqual(await snapshot(client),before,'Existing data or sequences changed');
    await client.query(dryRun?'rollback':'commit');
    return {result:dryRun?'MULTI_ROLE_DRY_RUN_OK':'MULTI_ROLE_UPGRADE_OK',existingDataPreserved:true,
      counts:Object.fromEntries(Object.entries(before).filter(([k])=>k!=='sequences').map(([k,v])=>[k,v.count]))};
  }catch(error){await client.query('rollback');throw error}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  assert(['--dry-run','--apply'].includes(process.argv[2]),'Use --dry-run or --apply');
  const client=new pg.Client({host:process.env.POSTGRES_HOST||'db',port:Number(process.env.POSTGRES_PORT||5432),database:process.env.POSTGRES_DB||'metrotech_erf',user:process.env.POSTGRES_USER||'metrotech_erf',password:process.env.POSTGRES_PASSWORD});
  try{await client.connect();console.log(JSON.stringify(await upgrade(client,{dryRun:process.argv[2]==='--dry-run'}),null,2))}
  finally{await client.end()}
}
