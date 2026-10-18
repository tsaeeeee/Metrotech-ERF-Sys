import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

export async function snapshot(client){
  const result={};
  const tables=(await client.query("select tablename from pg_tables where schemaname='public' and tablename<>'session' order by tablename")).rows;
  for(const {tablename} of tables){
    const id='"'+tablename.replaceAll('"','""')+'"';
    const row=tablename==='employees'?"to_jsonb(t)-'workflow_options'":tablename==='requests'?"to_jsonb(t)-'workflow_plan'":'to_jsonb(t)';
    result[tablename]=(await client.query(`select count(*)::text count,md5(coalesce(jsonb_agg(${row} order by (${row})::text)::text,'[]')) digest from ${id} t`)).rows[0];
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
    assert((await client.query("select to_regprocedure('employee_has_workflow_role(text,text,text)') ok")).rows[0].ok,'Multi-role EMS baseline is required.');
    // Maintenance window: freeze writes while proving every existing row is preserved.
    const tables=(await client.query("select tablename from pg_tables where schemaname='public' and tablename<>'session' order by tablename")).rows;
    for(const {tablename} of tables)await client.query(`lock table "${tablename.replaceAll('"','""')}" in share row exclusive mode`);
    const before=await snapshot(client);
    const sql=await fs.readFile(new URL('../../sql/migrations/019-executive-workflow.sql',import.meta.url),'utf8');
    await client.query(sql.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,''));
    for(const [table,column] of [['employees','workflow_options'],['requests','workflow_plan']]){
      assert.equal((await client.query('select data_type from information_schema.columns where table_schema=\'public\' and table_name=$1 and column_name=$2',[table,column])).rows[0]?.data_type,'jsonb');
    }
    assert.deepEqual(await snapshot(client),before,'Existing data changed.');
    await client.query(dryRun?'rollback':'commit');
    return {result:dryRun?'EXECUTIVE_WORKFLOW_DRY_RUN_OK':'EXECUTIVE_WORKFLOW_UPGRADE_OK',existingDataPreserved:true,
      counts:Object.fromEntries(Object.entries(before).filter(([k])=>k!=='sequences').map(([k,v])=>[k,v.count]))};
  }catch(e){await client.query('rollback');throw e}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  assert(['--dry-run','--apply'].includes(process.argv[2]),'Use --dry-run or --apply');
  const client=new pg.Client({host:process.env.POSTGRES_HOST||'db',port:Number(process.env.POSTGRES_PORT||5432),database:process.env.POSTGRES_DB||'metrotech_erf',user:process.env.POSTGRES_USER||'metrotech_erf',password:process.env.POSTGRES_PASSWORD});
  try{await client.connect();console.log(JSON.stringify(await upgrade(client,{dryRun:process.argv[2]==='--dry-run'}),null,2))}
  finally{await client.end()}
}
