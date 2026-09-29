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
  const largeAmount=1234567890123456;
  request.total=largeAmount+1500000;
  const items=Array.from({length:16},(_,i)=>({
    category:`Akamai Expenses - Maintenance. `.repeat(5)+`END_CATEGORY${i+1}`,
    purpose:`ITEM${i+1} ${purpose} END_ITEM${i+1}`,
    payment_date:'2026-09-25',amount:i===0?largeAmount:100000
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
  for(let i=1;i<=16;i++){
    assert(text.includes(`END_ITEM${i}`),`Item ${i} purpose was cut off.`);
    assert(text.includes(`END_CATEGORY${i}`),`Item ${i} category was cut off.`);
  }
  assert(text.replace(/\s/g,'').includes('Rp1.234.567.890.123.456'),'Long amount was cut off.');
  assert(text.includes('TOTAL') && text.includes('Reviewed By'),'Total and signature area must remain on final page.');
  await pdf.destroy();

  await buildFormPdf({request:{...request,total:100000},items:[{...items[0],category:'Tools',purpose:'Short purpose',amount:100000}],outPath:path.join(dir,'short.pdf')});
  const shortPdf=await getDocument({data:new Uint8Array(await fs.readFile(path.join(dir,'short.pdf'))),useSystemFonts:true}).promise;
  assert(shortPdf.numPages===1,'Short forms should still fit on one page.');
  await shortPdf.destroy();

  const ecfPath=path.join(dir,'ecf.pdf');
  const bank={payment_to:'Example Account Holder With A Longer Registered Name',
    bank_name:'PT Bank Example Indonesia International Branch',bank_code:'008',account_number:'0012345678901234567890'};
  await buildFormPdf({
    request:{...request,form_type:'ECF',request_type:'EXPENSE',status:'APPROVED',
      checker_name:'Example Checker',...bank},
    items:[{category:'Tools',purpose:'Short claim purpose',payment_date:'2026-09-25',amount:100000}],
    outPath:ecfPath
  });
  const ecfPdf=await getDocument({data:new Uint8Array(await fs.readFile(ecfPath)),useSystemFonts:true}).promise;
  assert(ecfPdf.numPages===1,'ECF with wrapped bank details should still fit on one page.');
  let ecfText='';
  const firstPageItems=(await (await ecfPdf.getPage(1)).getTextContent()).items;
  for(let i=1;i<=ecfPdf.numPages;i++){
    const page=await ecfPdf.getPage(i);
    ecfText+=(await page.getTextContent()).items.map(item=>item.str).join(' ')+' ';
  }
  for(const label of ['EXPENSE CLAIM FORM','Prepared By','Checked By','Reviewed By','Approved By',
    'Payment To','Bank Name','Bank Code','Account Number'])
    assert(ecfText.includes(label),`ECF PDF is missing ${label}.`);
  for(const value of Object.values(bank))
    assert(ecfText.replace(/\s/g,'').includes(value.replace(/\s/g,'')),`ECF bank value was cut off: ${value}`);
  for(const label of ['Payment To','Bank Name','Bank Code','Account Number']){
    const item=firstPageItems.find(item=>item.str===label);
    assert(item.transform[4]>=297,'Bank details must appear on the right of Employee Information.');
  }
  const bankText=firstPageItems.filter(item=>item.str.trim() && item.transform[4]>=385 && item.transform[5]>620 && item.transform[5]<745);
  assert(bankText.length>4,'Long account-holder and bank names should wrap.');
  assert(bankText.every(item=>item.transform[4]+item.width<=545.1),'Bank text must stay inside the right column.');
  assert(!text.includes('Account Number'),'ERF PDFs must not gain the ECF bank section.');
  await ecfPdf.destroy();
  console.log('PDF_WRAP_SMOKE_OK');
}finally{
  await fs.rm(dir,{recursive:true,force:true});
}
