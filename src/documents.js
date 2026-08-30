import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { google } from 'googleapis';
import sharp from 'sharp';

const SIGNATURE_DIR=process.env.SIGNATURE_DIR || '/data/signatures';
const PDF_MODE=String(process.env.PDF_MODE || 'mock').toLowerCase();
const BRAND_LOGO_PATH=path.resolve(process.cwd(),'public/assets/metrotech-logo.webp');

function money(n){ return 'Rp ' + Number(n||0).toLocaleString('id-ID'); }

function isoDate(v){
  if(!v) return '';
  if(v instanceof Date && !Number.isNaN(v.getTime())){
    return [
      v.getUTCFullYear(),
      String(v.getUTCMonth()+1).padStart(2,'0'),
      String(v.getUTCDate()).padStart(2,'0')
    ].join('-');
  }
  const raw=String(v);
  const direct=raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const d=new Date(v);
  if(!Number.isNaN(d.getTime())){
    return [
      d.getUTCFullYear(),
      String(d.getUTCMonth()+1).padStart(2,'0'),
      String(d.getUTCDate()).padStart(2,'0')
    ].join('-');
  }
  return raw;
}

function displayDate(v){
  const iso=isoDate(v);
  const m=iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return iso;
  const mons=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${m[3]}-${mons[Number(m[2])-1]}-${m[1].slice(-2)}`;
}

async function ensureParent(filePath){ await fs.mkdir(path.dirname(filePath),{recursive:true}); }

function rightAlignedX(font,text,size,rightX){
  return rightX-font.widthOfTextAtSize(String(text||''),size);
}

function centeredX(font,text,size,left,width){
  return left+(width-font.widthOfTextAtSize(String(text||''),size))/2;
}

async function embedBrandLogo(doc){
  try{
    const webp=await fs.readFile(BRAND_LOGO_PATH);
    const png=await sharp(webp).png().toBuffer();
    return await doc.embedPng(png);
  }catch{
    return null;
  }
}

export async function buildEvidencePdf({items,files,outPath}) {
  await ensureParent(outPath);
  const out=await PDFDocument.create();

  for(let i=0;i<items.length;i++){
    const itemFiles=files.filter(f=>f.fieldname===`evidence_${i}`);

    for(const f of itemFiles){
      const type=String(f.mimetype||'').toLowerCase();

      if(type==='application/pdf'){
        const src=await PDFDocument.load(f.buffer);
        const copied=await out.copyPages(src,src.getPageIndices());
        copied.forEach(page=>out.addPage(page));
        continue;
      }

      if(type==='image/png' || type==='image/jpeg' || type==='image/jpg'){
        const image=type==='image/png' ? await out.embedPng(f.buffer) : await out.embedJpg(f.buffer);
        const maxPageDimension=842;
        const scale=Math.min(maxPageDimension/image.width,maxPageDimension/image.height,1);
        const width=Math.max(1,image.width*scale);
        const height=Math.max(1,image.height*scale);
        const page=out.addPage([width,height]);
        page.drawImage(image,{x:0,y:0,width,height});
      }
    }
  }

  await fs.writeFile(outPath,await out.save());
  return outPath;
}

async function embedSignature(doc, filename){
  if(!filename) return null;
  try{
    const signaturePath=path.isAbsolute(filename)?filename:path.join(SIGNATURE_DIR,filename);
    const bytes=await fs.readFile(signaturePath);
    if(filename.toLowerCase().endsWith('.jpg')||filename.toLowerCase().endsWith('.jpeg')) return await doc.embedJpg(bytes);
    return await doc.embedPng(bytes);
  }catch{return null}
}

function signatureVisibility(request){
  return {
    requestor:true,
    reviewer:['PENDING_APPROVAL','APPROVAL_REJECTED','APPROVED'].includes(request.status),
    approver:request.status==='APPROVED'
  };
}

async function stampSignaturesOnPdf(pdfBytes,request){
  const doc=await PDFDocument.load(pdfBytes);
  const page=doc.getPages()[0];
  if(!page) return pdfBytes;

  const visible=signatureVisibility(request);
  const sigs=[
    {file:request.requestor_signature,show:visible.requestor,x:Number(process.env.SIG_REQUESTOR_X||75),y:Number(process.env.SIG_REQUESTOR_Y||88)},
    {file:request.reviewer_signature,show:visible.reviewer,x:Number(process.env.SIG_REVIEWER_X||265),y:Number(process.env.SIG_REVIEWER_Y||88)},
    {file:request.approver_signature,show:visible.approver,x:Number(process.env.SIG_APPROVER_X||430),y:Number(process.env.SIG_APPROVER_Y||88)}
  ];
  const maxW=Number(process.env.SIG_WIDTH||90);
  const maxH=Number(process.env.SIG_HEIGHT||40);
  for(const s of sigs){
    if(!s.show) continue;
    const img=await embedSignature(doc,s.file);
    if(!img) continue;
    const scale=Math.min(maxW/img.width,maxH/img.height);
    page.drawImage(img,{x:s.x,y:s.y,width:img.width*scale,height:img.height*scale});
  }
  return await doc.save();
}

function sheetA1(title,cell){
  return `'${String(title).replaceAll("'","''")}'!${cell}`;
}

async function buildGoogleSheetFormPdf({request,items,outPath}){
  const templateId=process.env.TEMPLATE_SPREADSHEET_ID;
  if(!templateId) throw new Error('TEMPLATE_SPREADSHEET_ID is not configured.');

  const auth=new google.auth.GoogleAuth({
    scopes:[
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
  const authClient=await auth.getClient();
  const drive=google.drive({version:'v3',auth:authClient});
  const sheets=google.sheets({version:'v4',auth:authClient});

  let tempId=null;
  try{
    const workFolderId=String(process.env.TEMPLATE_WORK_FOLDER_ID||'').trim();
    const copied=await drive.files.copy({
      fileId:templateId,
      supportsAllDrives:true,
      requestBody:{
        name:`TEMP ${request.ref_no} r${request.revision}`,
        ...(workFolderId?{parents:[workFolderId]}:{})
      }
    });
    tempId=copied.data.id;
    if(!tempId) throw new Error('Failed to create temporary template copy.');

    const meta=await sheets.spreadsheets.get({
      spreadsheetId:tempId,
      fields:'sheets.properties'
    });
    const requestedTitle=String(process.env.TEMPLATE_SHEET_NAME||'').trim();
    const targetSheet=meta.data.sheets?.find(s=>s.properties?.title===requestedTitle) || meta.data.sheets?.[0];
    if(!targetSheet?.properties?.title) throw new Error('Template does not contain a usable sheet.');
    const title=targetSheet.properties.title;
    const gid=targetSheet.properties.sheetId;

    await sheets.spreadsheets.values.clear({
      spreadsheetId:tempId,
      range:sheetA1(title,'B16:G31')
    });
    await sheets.spreadsheets.values.clear({
      spreadsheetId:tempId,
      range:sheetA1(title,'G32')
    });

    const data=[
      {range:sheetA1(title,'G3'),values:[[isoDate(request.request_date)]]},
      {range:sheetA1(title,'G4'),values:[[request.ref_no]]},
      {range:sheetA1(title,'D9'),values:[[request.employee_name]]},
      {range:sheetA1(title,'D10'),values:[[request.employee_id]]},
      {range:sheetA1(title,'D11'),values:[[request.department]]},
      {range:sheetA1(title,'D12'),values:[[request.location]]},
      {range:sheetA1(title,'D13'),values:[[request.division]]},
      {range:sheetA1(title,'G32'),values:[[Number(request.total)]]}
    ];

    items.slice(0,16).forEach((it,i)=>{
      const row=16+i;
      data.push(
        {range:sheetA1(title,`B${row}`),values:[[it.category]]},
        {range:sheetA1(title,`E${row}`),values:[[it.purpose]]},
        {range:sheetA1(title,`F${row}`),values:[[isoDate(it.payment_date || it.paymentDate)]]},
        {range:sheetA1(title,`G${row}`),values:[[Number(it.amount)]]}
      );
    });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId:tempId,
      requestBody:{valueInputOption:'USER_ENTERED',data}
    });

    const tokenResponse=await authClient.getAccessToken();
    const token=typeof tokenResponse==='string'?tokenResponse:tokenResponse?.token;
    if(!token) throw new Error('Could not obtain Google access token.');

    const exportUrl=new URL(`https://docs.google.com/spreadsheets/d/${tempId}/export`);
    exportUrl.searchParams.set('format','pdf');
    exportUrl.searchParams.set('gid',String(gid));
    exportUrl.searchParams.set('portrait','true');
    exportUrl.searchParams.set('fitw','true');
    exportUrl.searchParams.set('sheetnames','false');
    exportUrl.searchParams.set('printtitle','false');
    exportUrl.searchParams.set('pagenumbers','false');
    exportUrl.searchParams.set('gridlines','false');
    exportUrl.searchParams.set('fzr','false');

    const response=await fetch(exportUrl,{headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok) throw new Error(`Google PDF export failed: HTTP ${response.status}`);
    const exported=new Uint8Array(await response.arrayBuffer());
    const stamped=await stampSignaturesOnPdf(exported,request);
    await ensureParent(outPath);
    await fs.writeFile(outPath,stamped);
    return outPath;
  } finally {
    if(tempId){
      try{await drive.files.delete({fileId:tempId,supportsAllDrives:true})}catch{}
    }
  }
}

async function buildMockFormPdf({request,items,outPath}) {
  await ensureParent(outPath);
  const doc=await PDFDocument.create();
  const page=doc.addPage([595,842]);
  const bold=await doc.embedFont(StandardFonts.HelveticaBold);
  const normal=await doc.embedFont(StandardFonts.Helvetica);

  const navy=rgb(0.035,0.20,0.39);
  const blue=rgb(0.12,0.42,0.67);
  const pale=rgb(0.95,0.97,0.99);
  const line=rgb(0.72,0.77,0.83);
  const grey=rgb(0.35,0.39,0.45);
  const yellow=rgb(0.98,0.73,0.08);
  const white=rgb(1,1,1);

  // Header / brand
  const brandLogo=await embedBrandLogo(doc);
  if(brandLogo){
    const logoW=112;
    const logoH=logoW*(brandLogo.height/brandLogo.width);
    page.drawImage(brandLogo,{x:42,y:786,width:logoW,height:logoH});
  }

  page.drawText('EXPENSE REQUEST FORM',{x:173,y:795,size:16.5,font:bold,color:navy});
  page.drawText('Operations Division',{x:238,y:779,size:7.8,font:normal,color:grey});

  const metaX=414;
  const metaY=775;
  const metaW=139;
  const metaH=38;
  page.drawRectangle({x:metaX,y:metaY,width:metaW,height:metaH,borderWidth:.55,borderColor:line,color:pale});
  page.drawLine({start:{x:metaX,y:metaY+19},end:{x:metaX+metaW,y:metaY+19},thickness:.45,color:line});
  page.drawText('Request Date',{x:metaX+7,y:metaY+26,size:6.3,font:bold,color:grey});
  const requestDateText=displayDate(request.request_date);
  page.drawText(requestDateText,{
    x:rightAlignedX(normal,requestDateText,7.2,metaX+metaW-7),
    y:metaY+26,size:7.2,font:normal,color:navy
  });
  page.drawText('Ref No',{x:metaX+7,y:metaY+7,size:6.3,font:bold,color:grey});
  const refText=String(request.ref_no||'');
  page.drawText(refText,{
    x:rightAlignedX(bold,refText,6.3,metaX+metaW-7),
    y:metaY+7,size:6.3,font:bold,color:navy
  });

  // Employee information
  page.drawRectangle({x:42,y:745,width:511,height:20,color:navy});
  page.drawText('EMPLOYEE INFORMATION',{x:52,y:751,size:8,font:bold,color:white});

  const infoRows=[
    ['Name',request.employee_name],
    ['Employee ID',request.employee_id],
    ['Department',request.department],
    ['Location',request.location],
    ['Division',request.division]
  ];
  let infoY=725;
  for(const [label,value] of infoRows){
    page.drawRectangle({x:42,y:infoY,width:511,height:20,borderWidth:.55,borderColor:line});
    page.drawRectangle({x:42,y:infoY,width:120,height:20,color:pale,borderWidth:.55,borderColor:line});
    page.drawText(label,{x:51,y:infoY+6,size:7.5,font:bold,color:grey});
    page.drawText(String(value||''),{x:173,y:infoY+6,size:8.5,font:normal,color:navy});
    infoY-=20;
  }

  // Expense table
  const tableTop=600;
  const rowH=20;
  const x0=42;
  const widths=[28,100,214,75,94];
  const heads=['No.','Category','Purpose of Payment','Payment Date','Amount (IDR)'];
  let cx=x0;
  page.drawRectangle({x:x0,y:tableTop,width:511,height:24,color:navy});
  for(let i=0;i<heads.length;i++){
    page.drawText(heads[i],{x:cx+5,y:tableTop+8,size:7,font:bold,color:white});
    cx+=widths[i];
  }

  let y=tableTop-rowH;
  for(let r=0;r<16;r++){
    let x=x0;
    for(const w of widths){
      page.drawRectangle({x,y,width:w,height:rowH,borderWidth:.5,borderColor:line});
      x+=w;
    }
    const it=items[r];
    if(it){
      page.drawText(String(r+1),{x:x0+9,y:y+6,size:7.5,font:normal,color:grey});
      page.drawText(String(it.category||'').slice(0,22),{x:x0+widths[0]+5,y:y+6,size:7.3,font:normal,color:navy});
      page.drawText(String(it.purpose||'').slice(0,48),{x:x0+widths[0]+widths[1]+5,y:y+6,size:7.3,font:normal,color:navy});
      page.drawText(displayDate(it.payment_date || it.paymentDate),{x:x0+widths[0]+widths[1]+widths[2]+5,y:y+6,size:7.2,font:normal,color:navy});
      page.drawText(money(it.amount).replace('Rp ','Rp'),{x:x0+widths[0]+widths[1]+widths[2]+widths[3]+5,y:y+6,size:7.1,font:normal,color:navy});
    }
    y-=rowH;
  }

  // Total
  page.drawRectangle({x:x0,y:y,width:417,height:23,color:pale,borderWidth:.65,borderColor:line});
  page.drawRectangle({x:x0+417,y:y,width:94,height:23,borderWidth:.65,borderColor:line});
  page.drawText('TOTAL',{x:x0+365,y:y+7,size:8,font:bold,color:navy});
  page.drawText(money(request.total).replace('Rp ','Rp'),{x:x0+423,y:y+7,size:8,font:bold,color:navy});

  // Signature area
  const sigY=72;
  const sigTop=158;
  const sigW=170.33;
  const visible=signatureVisibility(request);
  const sigCols=[
    {label:'Prepared By',name:request.employee_name,file:request.requestor_signature,show:visible.requestor,x:42},
    {label:'Reviewed By',name:request.reviewer_name,file:request.reviewer_signature,show:visible.reviewer,x:42+sigW},
    {label:'Approved By',name:request.approver_name,file:request.approver_signature,show:visible.approver,x:42+(sigW*2)}
  ];

  for(const s of sigCols){
    page.drawRectangle({x:s.x,y:sigY,width:sigW,height:sigTop-sigY,borderWidth:.65,borderColor:line});
    page.drawRectangle({x:s.x,y:sigTop-20,width:sigW,height:20,color:pale,borderWidth:.65,borderColor:line});
    page.drawText(s.label,{x:s.x+8,y:sigTop-13,size:7.5,font:bold,color:navy});

    if(s.show){
      const img=await embedSignature(doc,s.file);
      if(img){
        const maxW=118,maxH=52;
        const scale=Math.min(maxW/img.width,maxH/img.height);
        const w=img.width*scale,h=img.height*scale;
        page.drawImage(img,{x:s.x+(sigW-w)/2,y:sigY+18,width:w,height:h});
      }
    }
    const name=String(s.name||'').slice(0,28);
    page.drawLine({start:{x:s.x+24,y:sigY+20},end:{x:s.x+sigW-24,y:sigY+20},thickness:.5,color:line});
    page.drawText(name,{
      x:centeredX(normal,name,7,s.x,sigW),
      y:sigY+7,size:7,font:normal,color:navy
    });
  }

  // Footer accent: blue on the left, small diagonal gap, yellow on the right.
  page.drawSvgPath('M 0 0 L 397 0 L 405 8 L 0 8 Z',{x:42,y:42,color:navy});
  page.drawSvgPath('M 8 0 L 96 0 L 96 8 L 0 8 Z',{x:457,y:42,color:yellow});

  await fs.writeFile(outPath,await doc.save());
  return outPath;
}

export async function buildFormPdf(args) {
  if(PDF_MODE==='google-sheet') return buildGoogleSheetFormPdf(args);
  return buildMockFormPdf(args);
}
