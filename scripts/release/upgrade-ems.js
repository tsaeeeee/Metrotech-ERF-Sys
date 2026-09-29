import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

// Only for the verified production ERF baseline (332903b).
// 013/014 are already installed and MUST NOT reset existing onboarding flags.
export const migrations=[
  '008-ecf-foundation.sql','009-ecf-role-management.sql',
  '010-sync-ecf-role-with-primary-user-state.sql','011-fix-ecf-role-assignment-ambiguity.sql',
  '012-fix-ecf-role-upsert-conflict.sql','015-ems-foundation.sql',
  '016-ems-claim-flow.sql','017-independent-erf-access.sql'
];
const tables=['employees','requests','request_items','workflow_actions','email_log','daily_counters','app_settings'];

export async function snapshot(client){
  const result={};
  for(const table of tables){
    // Ignore only the new discriminator; all other stored values must match.
    const row=table==='requests'?"to_jsonb(t)-'form_type'":'to_jsonb(t)';
    const {rows}=await client.query(`SELECT count(*)::text AS count,
      md5(coalesce(jsonb_agg(${row} ORDER BY (${row})::text)::text,'[]')) AS digest FROM ${table} t`);
    result[table]=rows[0];
  }
  result.sequences=(await client.query(`SELECT sequencename,last_value::text
    FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)).rows;
  return result;
}

export async function upgrade(client,{dryRun=false}={}){
  await client.query('BEGIN');
  try{
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(77123018)");
    await client.query(`LOCK TABLE ${tables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const {rows:[state]}=await client.query(`SELECT
      to_regclass('public.employee_form_roles') IS NOT NULL OR
      to_regclass('public.employee_payment_profiles') IS NOT NULL OR
      to_regclass('public.ecf_details') IS NOT NULL OR
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='requests' AND column_name='form_type') AS ecf_exists,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
        AND table_name='employees' AND column_name IN ('must_change_password','must_upload_signature'))=2 AS setup_exists`);
    if(state.ecf_exists||!state.setup_exists)
      throw new Error('Unsupported or already migrated database. Expected ERF baseline with onboarding columns and no ECF tables.');
    const before=await snapshot(client);
    for(const name of migrations){
      const sql=await fs.readFile(new URL(`../../sql/migrations/${name}`,import.meta.url),'utf8');
      // Run the reviewed migration bodies inside ONE outer transaction.
      const body=sql.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'');
      await client.query(body);
    }
    const after=await snapshot(client);
    if(JSON.stringify(before)!==JSON.stringify(after))
      throw new Error('Preservation check failed; legacy data or sequence values changed.');
    const {rows:[checks]}=await client.query(`SELECT
      NOT EXISTS(SELECT 1 FROM requests WHERE form_type<>'ERF') AS legacy_erf,
      NOT EXISTS(SELECT 1 FROM ecf_details) AS no_claims_created,
      NOT EXISTS(SELECT 1 FROM employee_payment_profiles) AS no_profiles_created`);
    if(Object.values(checks).some(value=>!value))throw new Error('Unexpected ECF data after upgrade.');
    await client.query(dryRun?'ROLLBACK':'COMMIT');
    return {result:dryRun?'UPGRADE_DRY_RUN_OK':'UPGRADE_COMMITTED',
      preserved:Object.fromEntries(tables.map(table=>[table,before[table].count])),
      accountsAndPasswordsUnchanged:true,legacyDataUnchanged:true,sequencesUnchanged:true,
      onboardingResetSkipped:true,migrations};
  }catch(error){await client.query('ROLLBACK');throw error}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const mode=process.argv[2];
  if(!['--dry-run','--apply'].includes(mode))throw new Error('Use --dry-run or --apply explicitly.');
  const client=new pg.Client({host:process.env.POSTGRES_HOST||'db',port:Number(process.env.POSTGRES_PORT||5432),
    database:process.env.POSTGRES_DB||'metrotech_erf',user:process.env.POSTGRES_USER||'metrotech_erf',
    password:process.env.POSTGRES_PASSWORD});
  try{await client.connect();console.log(JSON.stringify(await upgrade(client,{dryRun:mode==='--dry-run'}),null,2));}
  finally{await client.end()}
}
