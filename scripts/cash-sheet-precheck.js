// Read-only review of the proposed annual-sheet sync. Never calls batchUpdate.
import {pool} from '../src/db.js';
import {google} from 'googleapis';
import {readYearSheets,planYearSync,grid,SYNC_KEY} from '../src/cash-sheet-sync.js';

const spreadsheetId=process.argv[2];
if(!spreadsheetId||!/^[A-Za-z0-9_-]+$/.test(spreadsheetId))throw Error('Supply the destination spreadsheet ID.');
const client=await pool.connect();let transaction=false;
try{
  await client.query('begin isolation level repeatable read read only');transaction=true;
  const books=(await client.query('select * from cash_books order by year,id')).rows;
  const entries=(await client.query('select *,entry_date::text date from cash_entries')).rows;
  const imports=(await client.query("select id,snapshot from cash_imports where state='IMPORTED'")).rows;
  await client.query('commit');transaction=false;
  if(process.argv.includes('--metadata-only')&&entries.some(e=>!e.voided&&e.activity.trim().toLowerCase()==='test ems cash tracker backup spreadsheet'))throw Error('The known test transaction is still active. Remove it through Cash Tracker before reviewing the office sync.');
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
  if(process.argv.includes('--reclaim-deleted-157')){
    const sheet=metadata.sheets.find(s=>s.properties.title==='2026');
    const previous=JSON.parse(sheet?.developerMetadata?.find(m=>m.metadataKey===SYNC_KEY)?.metadataValue||'{}');
    const next=plan.expected.find(s=>s.title==='2026');
    if(!next||plan.requests.some(r=>!r.createDeveloperMetadata&&!r.updateDeveloperMetadata))throw Error('Reclaim gate: existing cells must not change.');
    for(let row=157;row<=161;row++){
      const ids=Object.entries(previous.entryRows||{}).filter(([,n])=>n===row).map(([id])=>id);
      if(ids.length!==1||!entries.some(e=>e.id===ids[0]&&e.book_id===previous.book&&e.voided)||next.state.entryRows[ids[0]]!==undefined||!next.state.freeRows.includes(row))throw Error(`Reclaim gate: row ${row} is not a verified deleted slot.`);
    }
    if(Math.min(...next.state.freeRows)!==157)throw Error('Reclaim gate: next free row is not 157.');
    const donor=entries.find(e=>e.book_id===previous.book&&!e.voided&&e.origin!=='LEGACY');
    if(!donor)throw Error('Reclaim gate: no active native entry to simulate.');
    const probe={...donor,id:'reclaim-precheck-probe',date:'2026-11-24',created_at:'2099-01-01',activity:'Read-only allocation probe',voided:false};
    const simulated=planYearSync({metadata,books,entries:[...entries,probe],imports});
    if(simulated.expected.find(s=>s.title==='2026')?.state.entryRows[probe.id]!==157||simulated.requests.some(r=>{
      if(r.createDeveloperMetadata||r.updateDeveloperMetadata)return false;
      const start=r.updateCells?.start;
      return !start||start.sheetId!==sheet.properties.sheetId||start.rowIndex!==156||start.columnIndex<0||start.columnIndex>4;
    }))throw Error('Reclaim gate: simulated next entry does not exclusively use A157:E157.');
    console.log('DELETED_SLOTS_VERIFIED: 157-161; no existing cells need writing.');
    console.log('NEXT_ENTRY_ROW_157_VERIFIED: read-only simulation only.');
  }
  if(process.argv.includes('--move-161-to-157')){
    const sheet=metadata.sheets.find(s=>s.properties.title==='2026');
    const previous=JSON.parse(sheet?.developerMetadata?.find(m=>m.metadataKey===SYNC_KEY)?.metadataValue||'{}');
    const movedId=Object.entries(previous.entryRows||{}).find(([id,row])=>row===161&&entries.some(e=>e.id===id&&!e.voided))?.[0];
    const next=plan.expected.find(s=>s.title==='2026');
    if(!movedId||next?.state.entryRows[movedId]!==157)throw Error('Expected active transaction at row 161 moving to row 157 was not found.');
    if(plan.requests.some(r=>{
      if(r.createDeveloperMetadata||r.updateDeveloperMetadata)return false;
      const start=r.updateCells?.start;
      return !start||start.sheetId!==sheet.properties.sheetId||![156,160].includes(start.rowIndex)||start.columnIndex<0||start.columnIndex>4;
    }))throw Error('Move-only gate: changes extend beyond 2026 A157:E157 and A161:E161. Review before rollout.');
    console.log('MOVE_161_TO_157_VERIFIED: only the two reviewed input rows can change.');
  }
  console.log('PRECHECK_OK: no database or spreadsheet writes performed.');
}catch(error){
  if(transaction)await client.query('rollback');
  console.error('PRECHECK_STOP:',String(error.message).slice(0,600));process.exitCode=1;
}finally{client.release();await pool.end();}
