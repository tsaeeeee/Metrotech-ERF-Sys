import {google} from 'googleapis';
import {fail} from './cash-model.js';
import {syncAnnualSheets} from './cash-sheet-sync.js';

const wib=now=>new Date(now.getTime()+7*3600000).toISOString();
export async function backupStatus(pool){
  const settings=(await pool.query('select * from cash_backup_settings where id=1')).rows[0];
  const runs=(await pool.query('select * from cash_backups order by started_at desc limit 10')).rows;
  return {settings,credentialConfigured:Boolean(process.env.CASH_GOOGLE_KEY_FILE),runs};
}
export async function backupCash(pool,{manual=false,now=new Date(),sheetsClient}={}){
  if(process.env.EMS_STAGING==='true'&&!sheetsClient)fail('External backups are disabled in rehearsal.',409);
  const client=await pool.connect();let locked=false,run;
  try{
    locked=(await client.query('select pg_try_advisory_lock(77123022) ok')).rows[0].ok;
    if(!locked){if(manual)fail('A backup is already running.',409);return {skipped:true};}
    const settings=(await client.query('select * from cash_backup_settings where id=1')).rows[0];
    const today=wib(now).slice(0,10),hour=Number(wib(now).slice(11,13));
    if(!manual&&(!settings?.enabled||hour<settings.hour_wib))return {skipped:true};
    if(!settings?.spreadsheet_id)fail('Configure the backup spreadsheet first.',409);
    if(!sheetsClient&&!process.env.CASH_GOOGLE_KEY_FILE)fail('Google backup credential is not configured.',409);
    const last=(await client.query('select state,started_at from cash_backups where backup_day=$1 and spreadsheet_id=$2 order by started_at desc limit 1',[today,settings.spreadsheet_id])).rows[0];
    if(!manual&&last&&(last.state==='OK'||now-new Date(last.started_at)<10*60000))return {skipped:true};
    run=(await client.query("insert into cash_backups(backup_day,state,spreadsheet_id) values($1,'RUNNING',$2) returning id",[today,settings.spreadsheet_id])).rows[0];
    await client.query('begin isolation level repeatable read read only');
    let entries,books,imports;
    try{
      books=(await client.query('select * from cash_books order by year,id')).rows;
      entries=(await client.query('select *,entry_date::text date from cash_entries order by book_id,entry_date,created_at,source_row nulls last,id')).rows;
      imports=(await client.query("select id,snapshot from cash_imports where state='IMPORTED'")).rows;
      await client.query('commit');
    }catch(e){await client.query('rollback');throw e}
    const sheets=sheetsClient||google.sheets({version:'v4',auth:new google.auth.GoogleAuth({keyFilename:process.env.CASH_GOOGLE_KEY_FILE,scopes:['https://www.googleapis.com/auth/spreadsheets']})});
    const {rows,checksum}=await syncAnnualSheets(sheets,settings.spreadsheet_id,{books,entries,imports});
    await client.query("update cash_backups set state='OK',finished_at=now(),row_count=$2,checksum=$3 where id=$1",[run.id,rows,checksum]);
    return {ok:true,id:run.id,rows,checksum};
  }catch(e){
    // Do not copy credential/provider request objects into user-visible logs.
    if(run)await client.query("update cash_backups set state='FAILED',finished_at=now(),error=$2 where id=$1",[run.id,e.status===409?e.message:'Backup failed. Check Google access and server configuration.']);
    if(e.status)throw e;
    throw Object.assign(new Error('Cash backup could not be verified. Check configuration and retry.'),{status:502});
  }finally{try{if(locked)await client.query('select pg_advisory_unlock(77123022)')}finally{client.release()}}
}
export function startCashBackupScheduler(pool){
  if(!process.env.CASH_GOOGLE_KEY_FILE)return;
  let busy=false;
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{await backupCash(pool)}catch{console.error('CASH_BACKUP_FAILED')}finally{busy=false}},60000);
  timer.unref();return timer;
}
