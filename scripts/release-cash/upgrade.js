import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

// Release verification deliberately keeps all original columns, including the
// workflow plan and permission assignments introduced in earlier releases.
export async function snapshot(client,{includeCash=false}={}){
  const result={};
  const tables=(await client.query("select tablename from pg_tables where schemaname='public' and tablename<>'session' order by tablename")).rows;
  for(const {tablename:t} of tables){
    if(!includeCash&&t.startsWith('cash_'))continue;
    const name='"'+t.replaceAll('"','""')+'"';
    result[t]=(await client.query(`select count(*)::text count,md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text)::text,'[]')) digest from ${name} x`)).rows[0];
  }
  result.sequences=(await client.query("select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename")).rows.filter(r=>includeCash||!r.sequencename.startsWith('cash_'));
  return result;
}
export async function upgrade(client,{dryRun=false}={}){
  await client.query('begin');
  try{
    await client.query("set local lock_timeout='5s'");await client.query("set local statement_timeout='120s'");
    await client.query('select pg_advisory_xact_lock(77123001)');
    for(const [table,column] of [['employees','workflow_options'],['requests','workflow_plan']])
      assert.equal((await client.query("select data_type from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2",[table,column])).rows[0]?.data_type,'jsonb','Executive workflow baseline is required.');
    const tables=(await client.query("select tablename from pg_tables where schemaname='public' and tablename<>'session' order by tablename")).rows;
    for(const {tablename:t} of tables)await client.query(`lock table "${t.replaceAll('"','""')}" in share row exclusive mode`);
    const before=await snapshot(client,{includeCash:true});
    const sql=await fs.readFile(new URL('../../sql/migrations/020-cash-tracker.sql',import.meta.url),'utf8');
    await client.query(sql.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,''));
    const after=await snapshot(client,{includeCash:true});
    for(const [name,expected] of Object.entries(before)){
      if(name==='sequences')assert.deepEqual(after.sequences.filter(r=>before.sequences.some(s=>s.sequencename===r.sequencename)),expected);
      else assert.deepEqual(after[name],expected,`${name}: existing rows changed`);
    }
    for(const name of ['cash_access','cash_books','cash_imports','cash_entries','cash_audit','cash_backup_settings','cash_backups'])assert(after[name],`Missing ${name}`);
    assert.equal((await client.query("select data_type from information_schema.columns where table_schema='public' and table_name='cash_entries' and column_name='income'")).rows[0]?.data_type,'numeric');
    await client.query(dryRun?'rollback':'commit');
    return {result:dryRun?'CASH_UPGRADE_DRY_RUN_OK':'CASH_UPGRADE_OK',existingDataPreserved:true,counts:Object.fromEntries(Object.entries(before).filter(([k])=>k!=='sequences').map(([k,v])=>[k,v.count]))};
  }catch(e){await client.query('rollback');throw e}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  assert(['--dry-run','--apply'].includes(process.argv[2]),'Use --dry-run or --apply');
  const client=new pg.Client({host:process.env.POSTGRES_HOST||'db',port:Number(process.env.POSTGRES_PORT||5432),database:process.env.POSTGRES_DB||'metrotech_erf',user:process.env.POSTGRES_USER||'metrotech_erf',password:process.env.POSTGRES_PASSWORD});
  try{await client.connect();console.log(JSON.stringify(await upgrade(client,{dryRun:process.argv[2]==='--dry-run'}),null,2))}finally{await client.end()}
}
