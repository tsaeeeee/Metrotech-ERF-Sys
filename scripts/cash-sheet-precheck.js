// Read-only review of the proposed annual-sheet sync. Never calls batchUpdate.
import {pool} from '../src/db.js';
import {google} from 'googleapis';
import {readYearSheets,planYearSync,grid} from '../src/cash-sheet-sync.js';

const spreadsheetId=process.argv[2];
if(!spreadsheetId||!/^[A-Za-z0-9_-]+$/.test(spreadsheetId))throw Error('Supply the destination spreadsheet ID.');
const client=await pool.connect();let transaction=false;
try{
  await client.query('begin isolation level repeatable read read only');transaction=true;
  const books=(await client.query('select * from cash_books order by year,id')).rows;
  const entries=(await client.query('select *,entry_date::text date from cash_entries')).rows;
  const imports=(await client.query("select id,snapshot from cash_imports where state='IMPORTED'")).rows;
  await client.query('commit');transaction=false;
  if(entries.some(e=>!e.voided&&e.activity.trim().toLowerCase()==='test ems cash tracker backup spreadsheet'))throw Error('The known test transaction is still active. Remove it through Cash Tracker before reviewing the office sync.');
  const sheets=google.sheets({version:'v4',auth:new google.auth.GoogleAuth({keyFilename:process.env.CASH_GOOGLE_KEY_FILE,scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']})});
  const info=(await sheets.spreadsheets.get({spreadsheetId,fields:'properties(title)'},{timeout:30000})).data;
  console.log('TARGET:',info.properties.title);console.log('SPREADSHEET_ID:',spreadsheetId);
  const metadata=await readYearSheets(sheets,spreadsheetId);
  const plan=planYearSync({metadata,books,entries,imports});
  for(const expected of plan.expected){
    console.log('BOOK:',expected.title,'EMS_ROW_MAPPING:',JSON.stringify(expected.state.entryRows));
  }
  const writes=plan.requests.filter(r=>r.updateCells);
  console.log('ACTIVE_ENTRIES:',plan.rows);
  console.log('PLANNED_OPERATIONS:',plan.requests.length);
  console.log('CELL_WRITES:',writes.length);
  console.log('NEW_SHEETS:',plan.requests.filter(r=>r.duplicateSheet).length);
  for(const r of writes.slice(0,30)){
    const u=r.updateCells,sheet=metadata.sheets.find(s=>s.properties.sheetId===u.start.sheetId);
    const before=sheet?grid(sheet)[u.start.rowIndex]?.[u.start.columnIndex]?.userEnteredValue:null;
    console.log('CELL_CHANGE:',JSON.stringify({sheet:sheet?.properties.title||'NEW',row:u.start.rowIndex+1,col:u.start.columnIndex+1,before:before||{},after:u.rows[0].values[0].userEnteredValue||{}}));
  }
  if(writes.length>30)console.log('Cell-change output limited to first 30.');
  if(process.argv.includes('--metadata-only')&&plan.requests.some(r=>!r.createDeveloperMetadata&&!r.updateDeveloperMetadata))throw Error('Metadata-only gate: the proposed sync would change cells or sheets. Review before rollout.');
  console.log('PRECHECK_OK: no database or spreadsheet writes performed.');
}catch(error){
  if(transaction)await client.query('rollback');
  console.error('PRECHECK_STOP:',String(error.message).slice(0,600));process.exitCode=1;
}finally{client.release();await pool.end();}
