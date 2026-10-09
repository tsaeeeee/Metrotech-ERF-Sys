import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pool} from '../../src/db.js';

assert.equal(process.env.EMS_STAGING,'true','Only the isolated staging clone is supported.');
assert.equal(process.env.POSTGRES_HOST,'db');
assert.equal(process.env.POSTGRES_DB,'ems_staging');
const tables=['employees','requests','request_items','workflow_actions','email_log','daily_counters','app_settings','employee_form_roles','employee_payment_profiles','ecf_details'];
try{
  assert.equal((await pool.query('select current_database() as name')).rows[0].name,'ems_staging');
  const snapshot={};
  for(const table of tables){
    const row=table==='employees'?"to_jsonb(t)-'workflow_roles'":'to_jsonb(t)';
    snapshot[table]=(await pool.query(`select count(*)::text as count,md5(coalesce(jsonb_agg(${row} order by (${row})::text)::text,'[]')) as digest from ${table} t`)).rows[0];
  }
  snapshot.sequences=(await pool.query("select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename")).rows;
  if(process.argv[2]==='--snapshot'){
    console.log(JSON.stringify(snapshot));
  }else if(process.argv[2]==='--compare'){
    assert.deepEqual(snapshot,JSON.parse(await fs.readFile(process.argv[3],'utf8')),'Migration changed existing account or transaction data.');
    console.log('CLONE_DATA_PRESERVED');
  }else{
    const documents=(await pool.query(`select form_pdf_path as file from requests where form_pdf_path is not null and form_pdf_path<>''
      union select evidence_pdf_path from requests where evidence_pdf_path is not null and evidence_pdf_path<>''
      union select signature_file from employees where signature_file<>''`)).rows;
    for(const {file} of documents){
      const absolute=path.resolve(file);
      assert(absolute.startsWith('/data/pdfs/')||absolute.startsWith('/data/signatures/'),'Unsupported document path: '+absolute);
      assert((await fs.stat(absolute)).isFile(),'Missing document: '+absolute);
    }
    console.log(`CLONE_DOCUMENTS_VERIFIED: ${documents.length}`);
  }
}finally{await pool.end()}
