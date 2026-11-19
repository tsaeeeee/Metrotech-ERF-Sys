// Explicit, transactional import for a reviewed private snapshot. No email or
// Google write occurs here. Preview is the default; --apply requires its hash.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {inspectSnapshot} from '../src/cash-model.js';
import {importCashSnapshot} from '../src/cash.js';

const [filename,mode='--preview',checksum,actor]=process.argv.slice(2);
assert(filename&&['--preview','--apply'].includes(mode),'Usage: node scripts/cash-import.js /private/snapshot.json [--preview | --apply SHA256 ADMIN_EMAIL]');
const stat=await fs.stat(filename);assert(stat.size<=10*1024*1024,'Snapshot is larger than 10 MB.');
const snapshot=JSON.parse(await fs.readFile(filename,'utf8')),report=inspectSnapshot(snapshot);
const summary={...report,sheets:report.sheets.map(({entries,...s})=>({...s,count:entries.length}))};
if(mode==='--preview')console.log(JSON.stringify({result:'CASH_IMPORT_PREVIEW',...summary},null,2));
else{
  assert.equal(checksum,report.checksum,'Snapshot differs from the reviewed checksum.');assert(actor,'Administrator email is required.');
  const client=new pg.Client({host:process.env.POSTGRES_HOST||'db',port:Number(process.env.POSTGRES_PORT||5432),database:process.env.POSTGRES_DB||'metrotech_erf',user:process.env.POSTGRES_USER||'metrotech_erf',password:process.env.POSTGRES_PASSWORD});
  try{
    await client.connect();await client.query('begin');await client.query("set local lock_timeout='5s'");await client.query("set local statement_timeout='120s'");
    const user=(await client.query("select email from employees where lower(email)=lower($1) and active and role='ADMIN'",[actor])).rows[0];assert(user,'Active administrator not found.');
    const result=await importCashSnapshot(client,snapshot,user.email);await client.query('commit');
    console.log(JSON.stringify({result:'CASH_IMPORTED',...result,report:summary},null,2));
  }catch(e){await client.query('rollback');throw e}finally{await client.end()}
}
