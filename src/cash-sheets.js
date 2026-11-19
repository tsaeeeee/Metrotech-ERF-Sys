import {google} from 'googleapis';
import {randomInt} from 'node:crypto';
import {digest,fail} from './cash-model.js';

const tag='metrotech_ems_cash_backup_v1';
const wib=now=>new Date(now.getTime()+7*3600000).toISOString();
export async function backupStatus(pool){
  const settings=(await pool.query('select * from cash_backup_settings where id=1')).rows[0];
  const runs=(await pool.query('select * from cash_backups order by started_at desc limit 10')).rows;
  return {settings,credentialConfigured:Boolean(process.env.CASH_GOOGLE_KEY_FILE),runs};
}
export function backupRequests(metadata,tables){
  const requests=[],used=new Set((metadata.sheets||[]).map(s=>s.properties.sheetId));
  for(const [title,values] of Object.entries(tables)){
    let sheet=(metadata.sheets||[]).find(s=>s.properties.title===title);
    if(sheet&&!sheet.developerMetadata?.some(m=>m.metadataKey===tag&&m.metadataValue===title))fail(`Backup tab ${title} already exists without EMS ownership. Rename it before enabling backup.`,409);
    let sheetId=sheet?.properties.sheetId;
    if(sheetId===undefined){do{sheetId=randomInt(1,2147483647)}while(used.has(sheetId));used.add(sheetId);
      requests.push({addSheet:{properties:{sheetId,title,gridProperties:{rowCount:Math.max(100,values.length),columnCount:values[0].length,frozenRowCount:1}}}});
      requests.push({createDeveloperMetadata:{developerMetadata:{metadataKey:tag,metadataValue:title,location:{sheetId},visibility:'DOCUMENT'}}});
    }
    const rows=Math.max(sheet?.properties.gridProperties.rowCount||100,values.length),columns=Math.max(sheet?.properties.gridProperties.columnCount||0,values[0].length);
    if(sheet)requests.push({updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount:rows,columnCount:columns}},fields:'gridProperties.rowCount,gridProperties.columnCount'}});
    // A single batch publishes the complete snapshot, including clearing stale
    // trailing rows. Only tabs carrying our ownership metadata are touched.
    requests.push({updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:rows,startColumnIndex:0,endColumnIndex:columns},rows:values.map(row=>({values:row.map(value=>({userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:String(value??'')}}))})),fields:'userEnteredValue'}});
  }
  return requests;
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
    let entries,books,audit;
    try{
      books=(await client.query('select id,label,year,opening_balance from cash_books order by year,id')).rows;
      entries=(await client.query('select *,entry_date::text date from cash_entries order by book_id,entry_date,created_at,source_row nulls last,id')).rows;
      audit=(await client.query('select * from cash_audit order by id')).rows;
      await client.query('commit');
    }catch(e){await client.query('rollback');throw e}
    const tables={
      'EMS Cash Books':[['ID','BOOK','YEAR','OPENING BALANCE'],...books.map(b=>[b.id,b.label,b.year,Number(b.opening_balance)])],
      'EMS Cash Entries':[['ID','BOOK ID','DATE','CATEGORY','ACTIVITY','INCOME','OUTCOME','KIND','NOTES','VOIDED','ORIGIN','SOURCE ROW','IMPORT ID','VERSION','RECORDED BY','CREATED AT','UPDATED AT'],...entries.map(e=>[e.id,e.book_id,e.date,e.category,e.activity,Number(e.income),Number(e.outcome),e.kind,e.notes,e.voided?'Yes':'No',e.origin,e.source_row??'',e.import_id??'',e.version,e.created_by,new Date(e.created_at).toISOString(),new Date(e.updated_at).toISOString()])],
      'EMS Cash Audit':[['ID','ACTOR','ACTION','ENTRY ID','REASON','BEFORE','AFTER','TIME'],...audit.map(a=>[a.id,a.actor_email,a.action,a.entry_id||'',a.reason,JSON.stringify(a.before_data),JSON.stringify(a.after_data),new Date(a.created_at).toISOString()])]
    };
    const checksum=digest(tables);
    tables['EMS Cash Backup']=[['BATCH ID','CAPTURED AT','ENTRY COUNT','SHA256'],[run.id,now.toISOString(),entries.length,checksum]];
    const sheets=sheetsClient||google.sheets({version:'v4',auth:new google.auth.GoogleAuth({keyFilename:process.env.CASH_GOOGLE_KEY_FILE,scopes:['https://www.googleapis.com/auth/spreadsheets']})});
    const spreadsheetId=settings.spreadsheet_id;
    const meta=(await sheets.spreadsheets.get({spreadsheetId,fields:'sheets(properties,developerMetadata)'},{timeout:30000})).data;
    const requests=backupRequests(meta,tables);
    await sheets.spreadsheets.batchUpdate({spreadsheetId,requestBody:{requests}},{timeout:60000});
    const check=(await sheets.spreadsheets.values.get({spreadsheetId,range:"'EMS Cash Backup'!A2:D2",valueRenderOption:'UNFORMATTED_VALUE'},{timeout:30000})).data.values?.[0];
    if(check?.[0]!==run.id||check?.[3]!==checksum||Number(check?.[2])!==entries.length)throw new Error('Backup verification did not match.');
    await client.query("update cash_backups set state='OK',finished_at=now(),row_count=$2,checksum=$3 where id=$1",[run.id,entries.length,checksum]);
    return {ok:true,id:run.id,rows:entries.length,checksum};
  }catch(e){
    // Do not copy credential/provider request objects into user-visible logs.
    if(run)await client.query("update cash_backups set state='FAILED',finished_at=now(),error=$2 where id=$1",[run.id,'Backup failed. Check Google access, tab ownership and server configuration.']);
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
