// Synchronize the existing annual template. Never add visible ID columns or
// rewrite headers, formulas, formatting, or the summary area of existing tabs.
import {randomInt} from 'node:crypto';
import {digest,fail,amount} from './cash-model.js';

export const SYNC_KEY='ems_cash_year_sync_v1';
const HEADERS=['DATE','CATEGORY','ACTIVITY','INCOME','OUTCOME'];
const annualTitle=title=>/^\d{4}$/.test(title)&&Number(title)>=2000&&Number(title)<=2200;
const clone=value=>structuredClone(value);
const raw=c=>c?.userEnteredValue||{};
const scalar=c=>c?.effectiveValue?.numberValue??c?.effectiveValue?.stringValue??c?.userEnteredValue?.numberValue??c?.userEnteredValue?.stringValue??'';
const blank=c=>!Object.keys(raw(c)).length||raw(c).stringValue==='';
const eq=(a,b)=>digest(a)===digest(b);
export const serial=date=>Math.round((Date.parse(date)-Date.UTC(1899,11,30))/86400000);
const v=value=>typeof value==='number'?{numberValue:value}:{stringValue:String(value)};
const stop=message=>fail(message,409);
export function grid(sheet){
  const rows=Array.from({length:sheet.properties.gridProperties.rowCount},()=>[]);
  for(const block of sheet.data||[])for(const [i,row] of (block.rowData||[]).entries())for(const [j,c] of (row?.values||[]).entries()){
    const index=(block.startRow||0)+i;if(rows[index])rows[index][(block.startColumn||0)+j]=c;
  }
  return rows;
}
const inputs=rows=>rows.slice(1).map(r=>Array.from({length:5},(_,c)=>raw(r[c])));
const layout=rows=>({header:Array.from({length:5},(_,c)=>raw(rows[0]?.[c])),right:rows.slice(0,70).map(r=>Array.from({length:20},(_,c)=>raw(r[c+5])))});
function normalized(value,c){
  if(c===0)return typeof value==='number'?value:serial(String(value));
  if(c>=3)return amount(value,{legacy:true});
  return String(value??'').trim();
}
const rowEquals=(cells,values)=>values.every((value,c)=>normalized(scalar(cells[c]),c)===normalized(value,c));
function inputValues(entry){return [serial(entry.date||entry.entry_date),entry.category,entry.activity,Number(entry.income),Number(entry.outcome)];}
function validateTemplate(sheet,rows){
  if(!eq(rows[0]?.slice(0,5).map(c=>scalar(c)),HEADERS))stop(`Sheet ${sheet.properties.title}: expected existing DATE/CATEGORY/ACTIVITY/INCOME/OUTCOME headers.`);
  // Respect the template's fixed formula coverage. Never append outside it or
  // extend formulas/whole rows (which could move the summary on the right).
  let capacity=sheet.properties.gridProperties.rowCount;
  const totals=[];
  for(const row of rows)for(const c of row.slice(5)){
    const f=raw(c).formulaValue||'';
    for(const m of f.matchAll(/\$?[ABDE]\$?2:\$?[ABDE]\$?(\d+)/g))capacity=Math.min(capacity,Number(m[1]));
    const total=f.match(/^=SUM\(\$?([DE])\$?2:\$?\1\$?(\d+)\)$/i);if(total)totals.push(total[1].toUpperCase());
  }
  if(!totals.includes('D')||!totals.includes('E')||capacity<2)stop(`Sheet ${sheet.properties.title}: unrecognized total formulas; no cells written.`);
  return capacity;
}
function metadataRequest(sheetId,value,existing){
  if(existing)return {updateDeveloperMetadata:{dataFilters:[{developerMetadataLookup:{metadataId:existing.metadataId}}],developerMetadata:{metadataValue:JSON.stringify(value)},fields:'metadataValue'}};
  return {createDeveloperMetadata:{developerMetadata:{metadataKey:SYNC_KEY,metadataValue:JSON.stringify(value),location:{sheetId},visibility:'DOCUMENT'}}};
}
const cellRequest=(sheetId,row,col,value)=>({updateCells:{start:{sheetId,rowIndex:row,columnIndex:col},rows:[{values:[Object.keys(value).length?{userEnteredValue:value}:{}]}],fields:'userEnteredValue'}});
function marker(sheet){
  const tags=(sheet.developerMetadata||[]).filter(m=>m.metadataKey===SYNC_KEY);
  if(tags.length>1)stop(`Sheet ${sheet.properties.title}: duplicate EMS markers.`);
  if(!tags.length)return null;
  try{return {metadata:tags[0],value:JSON.parse(tags[0].metadataValue)}}catch{stop('Invalid EMS sheet marker.');}
}

export function planYearSync({metadata,books,entries,imports}){
  const requests=[],expected=[],used=new Set(metadata.sheets.map(s=>s.properties.sheetId)),years=new Set();
  const snapshots=new Map(imports.map(i=>[i.id,i.snapshot]));
  const annual=metadata.sheets.filter(s=>annualTitle(s.properties.title));
  const template=annual.find(s=>s.properties.title==='2026')||annual.sort((a,b)=>b.properties.title.localeCompare(a.properties.title))[0];
  if(!template)stop('No annual cash template exists in this spreadsheet.');
  for(const book of books){
    const title=String(book.year);
    if(years.has(title))stop(`More than one EMS book uses year ${title}. Resolve the duplicate before syncing.`);
    years.add(title);
    let sheet=annual.find(s=>s.properties.title===title),isNew=!sheet;
    const source=sheet||template,sourceRows=grid(source);
    const capacity=validateTemplate(source,sourceRows);
    if(isNew){
      // Only clone the reviewed template: its summary references are local.
      // A linked carryover formula from an old year is not a blank template.
      if(sourceRows.slice(1).some(r=>r.slice(0,5).some(c=>raw(c).formulaValue)))stop('Choose an annual template without transaction formulas for new books.');
      if(sourceRows.some(r=>r.slice(5).some(c=>raw(c).formulaValue?.includes('!'))))stop('New-year template has cross-sheet formulas requiring review.');
      if(scalar(sourceRows[2]?.[6])!==`SUMMARY ${source.properties.title}`||!Array.from({length:12},(_,i)=>scalar(sourceRows[9+i]?.[6])).every((n,i)=>n===serial(`${source.properties.title}-${String(i+1).padStart(2,'0')}-01`)))stop('New-year template labels/months require review.');
      let sheetId;do{sheetId=randomInt(1,2147483647)}while(used.has(sheetId));used.add(sheetId);
      requests.push({duplicateSheet:{sourceSheetId:source.properties.sheetId,newSheetId:sheetId,newSheetName:title}});
      // Google duplicates sheet metadata too. Remove only this integration's tag
      // from the new copy, then bind the new book in the same atomic batch.
      requests.push({deleteDeveloperMetadata:{dataFilter:{developerMetadataLookup:{metadataKey:SYNC_KEY,metadataLocation:{sheetId},locationMatchingStrategy:'EXACT_LOCATION'}}}});
      sheet={...clone(source),properties:{...clone(source.properties),sheetId,title},developerMetadata:[]};
    }
    const sheetId=sheet.properties.sheetId,rows=grid(sheet),before=clone(rows),tag=isNew?null:marker(sheet);
    if(tag){
      if(tag.value.book!==book.id)stop(`Sheet ${title} is bound to a different EMS book.`);
      if(tag.value.input!==digest(inputs(rows))||tag.value.layout!==digest(layout(rows)))stop(`Sheet ${title} changed outside EMS. Reconcile the spreadsheet before syncing.`);
    }
    const bookEntries=entries.filter(e=>e.book_id===book.id),placements=new Map();
    const legacy=bookEntries.filter(e=>e.origin==='LEGACY');
    let end=book.source_sheet!=null?1:2; // reserve row 2 for a new book's opening balance
    for(const e of legacy){
      if(!Number.isSafeInteger(e.source_row)||e.source_row<2||placements.has(e.source_row))stop(`Invalid source-row mapping in ${title}.`);
      placements.set(e.source_row,e);end=Math.max(end,e.source_row);
    }
    for(const e of bookEntries.filter(e=>e.origin!=='LEGACY').sort((a,b)=>(new Date(a.created_at).getTime()-new Date(b.created_at).getTime())||a.id.localeCompare(b.id)))placements.set(++end,e);
    if(Number(book.opening_balance)!==0){
      if(book.source_sheet!=null)stop(`Book ${title}: imported opening balance requires reconciliation.`);
      placements.set(2,{id:`opening:${book.id}`,date:`${title}-01-01`,category:'Cash Deposit',activity:`Opening balance ${title}`,income:book.opening_balance,outcome:'0.00',origin:'EMS'});
    }
    if(end>capacity)stop(`Sheet ${title}: transactions exceed formula capacity at row ${capacity}. No rows or formulas were changed.`);
    if(!tag&&!isNew){
      // Initial binding: prove the legacy rows still match the immutable import
      // snapshot (or the current EMS values). Never claim an unknown populated row.
      for(let i=1;i<rows.length;i++){
        const cells=rows[i].slice(0,5),e=placements.get(i+1);
        if(!cells.some(c=>!blank(c)))continue;
        const snapshot=e&&snapshots.get(e.import_id),original=snapshot?.sheets.find(s=>String(s.sheetId)===String(book.source_sheet))?.rows.find(r=>r.row===i+1);
        if(!e||e.origin!=='LEGACY'||!original||(!rowEquals(cells,original.values.slice(0,5))&&!rowEquals(cells,inputValues(e))))stop(`Sheet ${title} row ${i+1}: data differs from the imported source. No cells written.`);
      }
      for(const [n,e] of placements)if(e.origin==='LEGACY'&&!rows[n-1]?.slice(0,5).some(c=>!blank(c)))stop(`Sheet ${title} row ${n}: an imported transaction is missing.`);
    }
    if(isNew){
      for(let r=1;r<rows.length;r++)for(let c=0;c<5;c++)rows[r][c]={...rows[r][c],userEnteredValue:{}};
      rows[2][6]={...rows[2][6],userEnteredValue:v(`SUMMARY ${title}`)};
      requests.push(cellRequest(sheetId,2,6,raw(rows[2][6])));
      for(let i=0;i<12;i++){rows[9+i][6]={...rows[9+i][6],userEnteredValue:v(serial(`${title}-${String(i+1).padStart(2,'0')}-01`))};requests.push(cellRequest(sheetId,9+i,6,raw(rows[9+i][6])));}
      // Row-specific notes from the old year must not leak into the new book.
      requests.push({repeatCell:{range:{sheetId,startRowIndex:1,endRowIndex:rows.length,startColumnIndex:0,endColumnIndex:5},cell:{},fields:'note'}});
    }
    const formulas=[];
    for(const [n,e] of placements){
      const r=n-1,cells=rows[r],values=e.voided?null:inputValues(e);
      if(values&&String(e.date||e.entry_date).slice(0,4)!==title)stop(`Book ${title}: transaction date belongs to a different year.`);
      for(let c=0;c<5;c++){
        if(!isNew&&raw(cells[c]).formulaValue){
          if(!values||normalized(scalar(cells[c]),c)!==normalized(values[c],c))stop(`Sheet ${title} ${String.fromCharCode(65+c)}${n} is formula-owned; reconcile its EMS amount first.`);
          formulas.push({row:r,col:c,value:values[c],formula:raw(cells[c]).formulaValue});continue;
        }
        if(!values){cells[c]={...cells[c],userEnteredValue:{}};continue;}
        // Preserve existing literal spelling/zero blanks when values are equal.
        if(!isNew&&normalized(scalar(cells[c]),c)===normalized(values[c],c))continue;
        let value=values[c];const rule=cells[c]?.dataValidation;
        if(rule?.condition?.type==='ONE_OF_LIST'){
          const matches=(rule.condition.values||[]).map(v=>v.userEnteredValue).filter(v=>String(v).trim()===String(value).trim());
          if(matches.length===1)value=matches[0];else if(rule.strict)stop(`Sheet ${title} row ${n}: value is not permitted by its dropdown.`);
        }else if(rule?.strict&&rule.condition?.type!=='DATE_IS_VALID')stop(`Sheet ${title} row ${n}: unsupported validation.`);
        cells[c]={...cells[c],userEnteredValue:v(value)};
      }
    }
    // Write only changed literals. Existing formulas never appear in a write.
    for(let r=1;r<rows.length;r++)for(let c=0;c<5;c++)if(!eq(raw(before[r][c]),raw(rows[r][c])))requests.push(cellRequest(sheetId,r,c,raw(rows[r][c])));
    const state={book:book.id,input:digest(inputs(rows)),layout:digest(layout(rows))};
    if(!tag||!eq(tag.value,state))requests.push(metadataRequest(sheetId,state,tag?.metadata));
    expected.push({title,sheetId,state,formulas,rows,isNew});
  }
  // Avoid changing a source year underneath a formula-backed imported amount.
  for(const target of expected)for(const f of target.formulas)for(const source of expected){
    if((f.formula.includes(`'${source.title}'!`)||f.formula.includes(`${source.title}!`))&&requests.some(r=>r.updateCells?.start.sheetId===source.sheetId&&r.updateCells.start.columnIndex<5))stop(`Sheet ${target.title}: carryover formula depends on a year being changed. Reconcile the carryover first.`);
  }
  if(requests.length>10000)stop('Sync batch exceeds the reviewed limit. No cells written.');
  // Duplicate templates before any existing-year updates in this batch.
  // Otherwise the new sheet could inherit rows added earlier in the batch.
  const ordered=[...requests.filter(r=>r.duplicateSheet),...requests.filter(r=>!r.duplicateSheet)];
  return {requests:ordered,expected,checksum:digest(expected.map(e=>e.state)),rows:entries.filter(e=>!e.voided).length};
}

export async function readYearSheets(sheets,spreadsheetId){
  const metadata=(await sheets.spreadsheets.get({spreadsheetId,fields:'spreadsheetId,sheets(properties,developerMetadata)'},{timeout:30000})).data;
  for(const sheet of metadata.sheets.filter(s=>annualTitle(s.properties.title))){
    const p=sheet.properties,rc=p.gridProperties.rowCount;
    if(rc>20000||p.gridProperties.columnCount<10)stop(`Sheet ${p.title}: unsupported grid size.`);
    const ranges=[`'${p.title}'!A1:E${rc}`,`'${p.title}'!F1:${String.fromCharCode(64+Math.min(25,p.gridProperties.columnCount))}${Math.min(70,rc)}`];
    const result=(await sheets.spreadsheets.get({spreadsheetId,ranges,includeGridData:true,fields:'sheets(data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,dataValidation,note))))'},{timeout:30000})).data;
    sheet.data=result.sheets?.[0]?.data||[];
  }
  return metadata;
}
export function verifyYearSync(metadata,plan){
  for(const expected of plan.expected){
    const sheet=metadata.sheets.find(s=>s.properties.sheetId===expected.sheetId),state=sheet&&marker(sheet)?.value;
    if(!sheet||!eq(state,expected.state))throw new Error('Annual sync marker verification failed.');
    const rows=grid(sheet);
    if(digest(inputs(rows))!==state.input||digest(layout(rows))!==state.layout)throw new Error('Annual sync cell verification failed.');
    for(const f of expected.formulas)if(normalized(scalar(rows[f.row][f.col]),f.col)!==normalized(f.value,f.col))throw new Error('Formula-owned input no longer agrees with EMS.');
  }
}
export async function syncAnnualSheets(sheets,spreadsheetId,data){
  const before=await readYearSheets(sheets,spreadsheetId),plan=planYearSync({metadata:before,...data});
  // A second read catches edits during planning. Google Sheets has no cell CAS;
  // the destination must not be manually edited while this batch is in flight.
  const fresh=await readYearSheets(sheets,spreadsheetId);
  if(digest(fresh)!==digest(before))stop('Spreadsheet changed during sync preparation. Retry after edits stop.');
  if(plan.requests.length)await sheets.spreadsheets.batchUpdate({spreadsheetId,requestBody:{requests:plan.requests}},{timeout:60000});
  verifyYearSync(await readYearSheets(sheets,spreadsheetId),plan);
  return {rows:plan.rows,checksum:plan.checksum};
}
