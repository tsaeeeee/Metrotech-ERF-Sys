// In-memory native Sheets adapter for isolated sync tests; no external writes.
export function sheetMemory(initial){
  let document=structuredClone(initial),next=1;let batches=0;
  const ensure=(s,r,c)=>{s.data||=[{rowData:[]}];s.data[0].rowData[r]||={values:[]};s.data[0].rowData[r].values[c]||={};return s.data[0].rowData[r].values[c]};
  // Normalize disjoint GridData into one dense coordinate grid.
  for(const s of document.sheets){const blocks=s.data||[];s.data=[{rowData:[]}];for(const b of blocks)for(const [r,row] of (b.rowData||[]).entries())for(const [c,cell] of (row?.values||[]).entries())Object.assign(ensure(s,(b.startRow||0)+r,(b.startColumn||0)+c),cell);}
  const match=(m,l)=>l.metadataId!=null?m.metadataId===l.metadataId:(!l.metadataKey||m.metadataKey===l.metadataKey)&&(!l.metadataLocation||m.location.sheetId===l.metadataLocation.sheetId);
  const adapter={spreadsheets:{get:async({ranges}={})=>({data:{...structuredClone(document),sheets:ranges?structuredClone(document.sheets.filter(s=>ranges.some(r=>r.startsWith("'"+s.properties.title+"'!")))):structuredClone(document.sheets)}}),batchUpdate:async({requestBody:{requests}})=>{
    const backup=structuredClone(document);try{for(const r of requests){
      if(r.duplicateSheet){const d=r.duplicateSheet,s=structuredClone(document.sheets.find(s=>s.properties.sheetId===d.sourceSheetId));s.properties.sheetId=d.newSheetId;s.properties.title=d.newSheetName;for(const m of s.developerMetadata||[]){m.metadataId=next++;m.location={sheetId:d.newSheetId};}document.sheets.push(s);}
      else if(r.updateCells){const u=r.updateCells,start=u.start,s=document.sheets.find(s=>s.properties.sheetId===start.sheetId);for(const [i,row] of u.rows.entries())for(const [j,c] of row.values.entries()){const cell=ensure(s,start.rowIndex+i,start.columnIndex+j);delete cell.userEnteredValue;delete cell.effectiveValue;if(c.userEnteredValue){cell.userEnteredValue=structuredClone(c.userEnteredValue);if(!c.userEnteredValue.formulaValue)cell.effectiveValue=structuredClone(c.userEnteredValue);}}}
      else if(r.repeatCell){const u=r.repeatCell,s=document.sheets.find(s=>s.properties.sheetId===u.range.sheetId);if(u.fields!=='note')throw Error('Unexpected field');for(let i=u.range.startRowIndex;i<u.range.endRowIndex;i++)for(let c=u.range.startColumnIndex;c<u.range.endColumnIndex;c++)delete ensure(s,i,c).note;}
      else if(r.createDeveloperMetadata){const m=structuredClone(r.createDeveloperMetadata.developerMetadata);m.metadataId=next++;const s=document.sheets.find(s=>s.properties.sheetId===m.location.sheetId);s.developerMetadata||=[];s.developerMetadata.push(m);}
      else if(r.updateDeveloperMetadata){const u=r.updateDeveloperMetadata;for(const s of document.sheets)for(const m of s.developerMetadata||[])if(u.dataFilters.some(f=>match(m,f.developerMetadataLookup)))m.metadataValue=u.developerMetadata.metadataValue;}
      else if(r.deleteDeveloperMetadata){const l=r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup;for(const s of document.sheets)s.developerMetadata=(s.developerMetadata||[]).filter(m=>!match(m,l));}
      else throw Error('Unexpected request '+Object.keys(r));
    }batches++;return {data:{}}}catch(e){document=backup;throw e}
  }}};
  return {adapter,get document(){return structuredClone(document)},get batches(){return batches}};
}
export function annualFixture(snapshot){
  const serial=date=>Math.round((Date.parse(date)-Date.UTC(1899,11,30))/86400000);
  return {sheets:snapshot.sheets.filter(s=>/^20\d{2}$/.test(s.title)).map(s=>{
    const rowData=Array.from({length:80},()=>({values:[]}));
    const put=(r,c,value)=>{rowData[r].values[c]={userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:value},effectiveValue:typeof value==='number'?{numberValue:value}:{stringValue:value},userEnteredFormat:{numberFormat:{type:c===0?'DATE':'NUMBER',pattern:c===0?'dd mmmm yyyy':'0.00'}}};};
    for(const r of s.rows)for(let c=0;c<5;c++)if(r.values[c]!=null&&r.values[c]!=='')put(r.row-1,c,r.row>1&&c===0?serial(r.values[c]):r.values[c]);
    put(2,6,`SUMMARY ${s.title}`);for(let i=0;i<12;i++)put(9+i,6,serial(`${s.title}-${String(i+1).padStart(2,'0')}-01`));
    rowData[4].values[7]={userEnteredValue:{formulaValue:'=SUM(D2:D75)'}};rowData[5].values[7]={userEnteredValue:{formulaValue:'=SUM(E2:E75)'}};
    return {properties:{sheetId:s.sheetId,title:s.title,gridProperties:{rowCount:80,columnCount:25}},data:[{rowData}]};
  })};
}
