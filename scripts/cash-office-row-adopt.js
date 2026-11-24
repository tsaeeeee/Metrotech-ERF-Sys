// One-time, narrowly scoped adoption of the reviewed office snack transaction.
import assert from 'node:assert/strict';
import {digest,amount} from '../src/cash-model.js';
import {grid,serial,SYNC_KEY,readYearSheets} from '../src/cash-sheet-sync.js';
export const OFFICE_ID='1t3d8Chi78zX2WcvKO-oRsrxwsRCAumD6ZsrHWcw5nf4';
export const OLD_ID='c2ba3b0c-b14d-4f45-896c-8e33ba4c651e';
export const NEW_ID='aaaf54c5-64f8-4d3d-9b62-eb11c7d85c0d';
const raw=c=>c?.userEnteredValue||{};
const scalar=c=>c?.effectiveValue?.numberValue??c?.effectiveValue?.stringValue??raw(c).numberValue??raw(c).stringValue??'';
export function adoption(sheet,entries){
  assert.equal(sheet.properties.sheetId,1455628154);assert.equal(sheet.properties.title,'2026');
  const tags=(sheet.developerMetadata||[]).filter(m=>m.metadataKey===SYNC_KEY);
  assert.equal(tags.length,1);const tag=tags[0],saved=JSON.parse(tag.metadataValue),rows=grid(sheet);
  const input=rows.slice(1).map(r=>Array.from({length:5},(_,c)=>raw(r[c])));
  const layout={header:Array.from({length:5},(_,c)=>raw(rows[0]?.[c])),right:rows.slice(0,70).map(r=>Array.from({length:20},(_,c)=>raw(r[c+5])))};
  assert.equal(digest(layout),saved.layout,'Header/formula changed');
  const e=entries.find(e=>e.id===NEW_ID),old=entries.find(e=>e.id===OLD_ID);
  assert.ok(e&&!e.voided&&old?.voided);assert.equal(e.book_id,saved.book);assert.equal(old.book_id,saved.book);
  assert.equal(e.origin,'EMS');assert.equal(serial(e.date),46349);assert.equal(Number(e.income),0);assert.equal(Number(e.outcome),258500);
  const norm=v=>v.map((x,c)=>c===0?(typeof x==='number'?x:serial(String(x))):c>=3?amount(x,{legacy:true}):String(x??'').trim());
  const values=e=>[serial(e.date),e.category,e.activity,Number(e.income),Number(e.outcome)];
  const actual=Array.from({length:5},(_,c)=>scalar(rows[156][c]));
  assert.ok(rows[156].slice(0,5).every(c=>!raw(c).formulaValue),'New row must contain literals');
  const matches=entries.filter(e=>!e.voided&&digest(norm(values(e)))===digest(norm(actual)));
  assert.equal(matches.length,1,'Office row must uniquely match one EMS entry');assert.equal(matches[0].id,NEW_ID);
  if(saved.entryRows?.[NEW_ID]===157&&!Object.hasOwn(saved.entryRows,OLD_ID)){
    assert.equal(digest(input),saved.input,'Sheet changed after adoption');return {tag,updated:saved,changed:false};
  }
  assert.equal(saved.entryRows?.[OLD_ID],157);assert.ok(!Object.hasOwn(saved.entryRows,NEW_ID));
  assert.equal(Object.values(saved.entryRows).filter(n=>n===157).length,1);
  const reconstructed=structuredClone(input);reconstructed[155]=[{}, {}, {}, {}, {}];
  assert.equal(digest(reconstructed),saved.input,'Changes extend beyond the reviewed insertion at row 157');
  const entryRows={...saved.entryRows};delete entryRows[OLD_ID];entryRows[NEW_ID]=157;
  return {tag,updated:{...saved,input:digest(input),entryRows},changed:true};
}
async function main(){
  const {pool}=await import('../src/db.js');
  try{
    const {google}=await import('googleapis');
    const settings=(await pool.query('select spreadsheet_id,enabled from cash_backup_settings where id=1')).rows[0];
    assert.equal(settings?.spreadsheet_id,OFFICE_ID);assert.equal(settings.enabled,false,'Pause Daily Backup first');
    const readEntries=async()=>(await pool.query('select *,entry_date::text date from cash_entries where book_id=$1',['0fbb59e4-be87-4070-8e67-ad9345357dcf'])).rows.sort((a,b)=>a.id.localeCompare(b.id));
    const entries=await readEntries(),apply=process.argv.includes('--apply');
    const sheets=google.sheets({version:'v4',auth:new google.auth.GoogleAuth({keyFilename:process.env.CASH_GOOGLE_KEY_FILE,scopes:[`https://www.googleapis.com/auth/spreadsheets${apply?'':'.readonly'}`]})});
    const before=await readYearSheets(sheets,OFFICE_ID),sheet=before.sheets.find(s=>s.properties.title==='2026');
    const result=adoption(sheet,entries);console.log('ROW_157_UNIQUE_MATCH_VERIFIED');
    if(!apply){console.log('READ_ONLY_ADOPTION_READY');return;}
    assert.equal(digest(await readEntries()),digest(entries),'EMS changed during verification');
    assert.equal(digest(await readYearSheets(sheets,OFFICE_ID)),digest(before),'Sheet changed during verification');
    if(result.changed){
      console.log('PREVIOUS_MARKER:',JSON.stringify(result.tag));
      await sheets.spreadsheets.batchUpdate({spreadsheetId:OFFICE_ID,requestBody:{requests:[{updateDeveloperMetadata:{dataFilters:[{developerMetadataLookup:{metadataId:result.tag.metadataId}}],developerMetadata:{metadataValue:JSON.stringify(result.updated)},fields:'metadataValue'}}]}},{timeout:30000});
    }
    const after=await readYearSheets(sheets,OFFICE_ID),checked=after.sheets.find(s=>s.properties.sheetId===sheet.properties.sheetId);
    assert.equal(digest(grid(checked)),digest(grid(sheet)),'Sheet cells changed during verification');
    assert.deepEqual(JSON.parse(checked.developerMetadata.find(m=>m.metadataId===result.tag.metadataId).metadataValue),result.updated);
    console.log('OFFICE_ROW_157_ADOPTED: metadata only; no cells or database rows written');
  }finally{await pool.end();}
}
if(process.argv[1]==='-'||process.argv[1]?.endsWith('/cash-office-row-adopt.js'))await main().catch(e=>{console.error('ADOPTION_STOP:',e.message);process.exitCode=1;});
