import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {buildFormPdf} from '../src/documents.js';

function assert(condition,message){if(!condition) throw new Error(message)}

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'erf-pdf-wrap-'));
try{
  const request={
    ref_no:'ERF-2026-0925-0001',request_date:'2026-09-25',employee_name:'Example User',
    employee_id:'TEST-001',department:'Operations',location:'Jakarta',division:'Operations',
    request_type:'EXPENSE',total:1600000,status:'PENDING_REVIEW'
  };
  const purpose='Replacement optics for data hall maintenance with exact service order and rack location. '.repeat(8);
  const items=Array.from({length:16},(_,i)=>({
    category:'Tools',purpose:`ITEM${i+1} ${purpose} END_ITEM${i+1}`,
    payment_date:'2026-09-25',amount:100000
  }));
  const outPath=path.join(dir,'long.pdf');
  await buildFormPdf({request,items,outPath});
  const pdf=await getDocument({data:new Uint8Array(await fs.readFile(outPath)),useSystemFonts:true}).promise;
  assert(pdf.numPages>1,'Long descriptions should flow onto additional pages.');
  let text='';
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    text+=(await page.getTextContent()).items.map(item=>item.str).join(' ')+' ';
  }
  for(let i=1;i<=16;i++) assert(text.includes(`END_ITEM${i}`),`Item ${i} purpose was cut off.`);
  assert(text.includes('TOTAL') && text.includes('Reviewed By'),'Total and signature area must remain on final page.');
  await pdf.destroy();

  await buildFormPdf({request:{...request,total:100000},items:items.slice(0,1).map(item=>({...item,purpose:'Short purpose'})),outPath:path.join(dir,'short.pdf')});
  const shortPdf=await getDocument({data:new Uint8Array(await fs.readFile(path.join(dir,'short.pdf'))),useSystemFonts:true}).promise;
  assert(shortPdf.numPages===1,'Short forms should still fit on one page.');
  await shortPdf.destroy();
  console.log('PDF_WRAP_SMOKE_OK');
}finally{
  await fs.rm(dir,{recursive:true,force:true});
}
