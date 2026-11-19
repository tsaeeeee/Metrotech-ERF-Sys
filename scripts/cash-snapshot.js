// Read every cell/formula/note from the legacy workbook into a private import
// snapshot. This command never modifies the spreadsheet or the EMS database.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {google} from 'googleapis';
import {inspectSnapshot} from '../src/cash-model.js';

export async function captureSnapshot(spreadsheetId,{sheets,drive}){
  const before=(await drive.files.get({fileId:spreadsheetId,fields:'id,modifiedTime,version'},{timeout:30000})).data;
  const metadata=(await sheets.spreadsheets.get({spreadsheetId,fields:'spreadsheetId,properties,sheets.properties'},{timeout:30000})).data;
  if(metadata.sheets.some(s=>s.properties.sheetType!=='GRID'))throw new Error('Non-grid sheet requires review; no sheet was skipped.');
  const cells=metadata.sheets.reduce((n,s)=>n+s.properties.gridProperties.rowCount*s.properties.gridProperties.columnCount,0);
  if(cells>1000000)throw new Error('Workbook is larger than the reviewed import limit.');
  const snapshot={format:'ems-cash-snapshot-v1',spreadsheetId,capturedAt:new Date().toISOString(),modifiedTime:before.modifiedTime,properties:metadata.properties,sheets:[]};
  const column=n=>{let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s};
  for(const {properties:p} of metadata.sheets){
    const target={sheetId:p.sheetId,title:p.title,gridProperties:p.gridProperties,rows:[]};
    for(let start=0;start<p.gridProperties.rowCount;start+=400){
      const range=`'${p.title.replaceAll("'","''")}'!A${start+1}:${column(p.gridProperties.columnCount)}${Math.min(start+400,p.gridProperties.rowCount)}`;
      const result=(await sheets.spreadsheets.get({spreadsheetId,ranges:[range],includeGridData:true,fields:'sheets(data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,note,hyperlink))))'},{timeout:30000})).data;
      for(const sheet of result.sheets||[])for(const grid of sheet.data||[])for(const [i,row] of (grid.rowData||[]).entries()){
        const raw=row.values||[];
        if(!raw.some(c=>c.effectiveValue||c.userEnteredValue||c.note||c.hyperlink))continue;
        if(raw.some(c=>c.effectiveValue?.errorValue))throw new Error(`Formula error in ${p.title}, row ${(grid.startRow||0)+i+1}.`);
        target.rows.push({row:(grid.startRow||0)+i+1,values:raw.map(c=>c.effectiveValue?.numberValue??c.effectiveValue?.stringValue??c.effectiveValue?.boolValue??''),
          notes:raw.map((c,j)=>c.note?`${column((grid.startColumn||0)+j+1)}: ${c.note}`:null).filter(Boolean).join('\n'),cells:raw});
      }
    }
    snapshot.sheets.push(target);
  }
  const after=(await drive.files.get({fileId:spreadsheetId,fields:'id,modifiedTime,version'},{timeout:30000})).data;
  if(after.modifiedTime!==before.modifiedTime||after.version!==before.version)throw new Error('Workbook changed during capture. Retry after spreadsheet edits pause.');
  inspectSnapshot(snapshot);return snapshot;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [spreadsheetId,output]=process.argv.slice(2);
  if(!/^[-\w]{20,150}$/.test(spreadsheetId||'')||!output||!path.isAbsolute(output)||!process.env.CASH_GOOGLE_KEY_FILE)
    throw new Error('Usage: CASH_GOOGLE_KEY_FILE=/private/key.json node scripts/cash-snapshot.js SPREADSHEET_ID /private/snapshot.json');
  const auth=new google.auth.GoogleAuth({keyFilename:process.env.CASH_GOOGLE_KEY_FILE,scopes:['https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.metadata.readonly']});
  const snapshot=await captureSnapshot(spreadsheetId,{sheets:google.sheets({version:'v4',auth}),drive:google.drive({version:'v3',auth})});
  await fs.writeFile(output,JSON.stringify(snapshot)+'\n',{mode:0o600,flag:'wx'});
  const report=inspectSnapshot(snapshot);
  console.log(JSON.stringify({result:'CASH_SNAPSHOT_READY',file:output,checksum:report.checksum,rows:report.count,sheets:report.sheets.map(s=>({title:s.title,rows:s.entries.length,balance:s.balance})),warnings:report.warnings},null,2));
}
