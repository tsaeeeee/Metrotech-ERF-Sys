import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { google } from 'googleapis';

const SIGNATURE_DIR=process.env.SIGNATURE_DIR || '/data/signatures';
const PDF_MODE=String(process.env.PDF_MODE || 'mock').toLowerCase();

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

export async function buildEvidencePdf({request,items,files,outPath}) {
  await ensureParent(outPath);
  const out=await PDFDocument.create();
  const bold=await out.embedFont(StandardFonts.HelveticaBold);
  const normal=await out.embedFont(StandardFonts.Helvetica);

  for(let i=0;i<items.length;i++){
    const item=items[i];
    const cover=out.addPage([595,842]);
    cover.drawText('EXPENSE EVIDENCE',{x:44,y:790,size:18,font:bold,color:rgb(0.04,0.22,0.41)});
    cover.drawText(request.ref_no,{x:44,y:765,size:11,font:bold});
    cover.drawText(`Payment #${i+1}`,{x:44,y:720,size:16,font:bold});
    const lines=[
      ['Category',item.category],
      ['Purpose',item.purpose],
      ['Payment Date',displayDate(item.paymentDate || item.payment_date)],
      ['Amount',money(item.amount)]
    ];
    let y=680;
    for(const [a,b] of lines){
      cover.drawText(a,{x:44,y,size:10,font:bold,color:rgb(.35,.39,.45)});
      cover.drawText(String(b||''),{x:160,y,size:11,font:normal});
      y-=28;
    }

    const itemFiles=files.filter(f=>f.fieldname===`evidence_${i}`);
    cover.drawText(`Attached files: ${itemFiles.length}`,{x:44,y:y-10,size:10,font:bold});

    for(const f of itemFiles){
      const type=String(f.mimetype||'').toLowerCase();
      if(type==='application/pdf'){
        const src=await PDFDocument.load(f.buffer);
        const copied=await out.copyPages(src,src.getPageIndices());
        copied.forEach(p=>out.addPage(p));
      } else if(type==='image/png' || type==='image/jpeg' || type==='image/jpg'){
        const image=type==='image/png' ? await out.embedPng(f.buffer) : await out.embedJpg(f.buffer);
        const page=out.addPage([595,842]);
        const maxW=515,maxH=742;
        const scale=Math.min(maxW/image.width,maxH/image.height,1);
        const w=image.width*scale,h=image.height*scale;
        page.drawText(f.originalname,{x:40,y:805,size:10,font:bold});
        page.drawImage(image,{x:(595-w)/2,y:(780-h)/2,width:w,height:h});
      }
    }
  }
  await fs.writeFile(outPath,await out.save());
  return outPath;
}

async function embedSignature(doc, filename){
  if(!filename) return null;
  try{
    const bytes=await fs.readFile(path.join(SIGNATURE_DIR,filename));
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
  const navy=rgb(0.04,0.22,0.41);
  const grey=rgb(.38,.42,.48);

  page.drawText('PT METROTECH INDONESIA',{x:42,y:795,size:12,font:bold,color:navy});
  page.drawText('EXPENSE REQUEST FORM',{x:42,y:770,size:20,font:bold,color:navy});
  page.drawText(`Request Date: ${displayDate(request.request_date)}`,{x:395,y:798,size:9,font:normal});
  page.drawText(`Ref No: ${request.ref_no}`,{x:395,y:782,size:9,font:bold});

  const info=[
    ['Name',request.employee_name],['Employee ID',request.employee_id],['Department',request.department],
    ['Location',request.location],['Division',request.division]
  ];
  let iy=735;
  for(const [a,b] of info){
    page.drawText(a,{x:42,y:iy,size:9,font:bold,color:grey});
    page.drawText(String(b||''),{x:135,y:iy,size:10,font:normal});
    iy-=20;
  }

  const top=620;
  page.drawRectangle({x:42,y:top,width:511,height:24,borderWidth:1,borderColor:rgb(.8,.84,.88),color:rgb(.96,.97,.98)});
  const heads=['#','Category','Purpose of Payment','Date','Amount'];
  const hx=[48,68,175,370,445];
  heads.forEach((h,i)=>page.drawText(h,{x:hx[i],y:top+8,size:8,font:bold,color:grey}));

  let y=top-22;
  const rowH=22;
  items.slice(0,16).forEach((it,i)=>{
    page.drawRectangle({x:42,y,width:511,height:rowH,borderWidth:.5,borderColor:rgb(.86,.88,.91)});
    page.drawText(String(i+1),{x:48,y:y+7,size:8,font:normal});
    page.drawText(String(it.category||'').slice(0,17),{x:68,y:y+7,size:8,font:normal});
    page.drawText(String(it.purpose||'').slice(0,40),{x:175,y:y+7,size:8,font:normal});
    page.drawText(displayDate(it.payment_date || it.paymentDate),{x:370,y:y+7,size:8,font:normal});
    page.drawText(money(it.amount),{x:445,y:y+7,size:8,font:normal});
    y-=rowH;
  });

  page.drawText('TOTAL',{x:365,y:y-4,size:10,font:bold});
  page.drawText(money(request.total),{x:445,y:y-4,size:10,font:bold,color:navy});

  const sigY=82;
  const visible=signatureVisibility(request);
  const sigCols=[
    {label:'Prepared By',name:request.employee_name,file:request.requestor_signature,show:visible.requestor,x:68},
    {label:'Reviewed By',name:request.reviewer_name,file:request.reviewer_signature,show:visible.reviewer,x:252},
    {label:'Approved By',name:request.approver_name,file:request.approver_signature,show:visible.approver,x:430}
  ];
  for(const s of sigCols){
    page.drawText(s.label,{x:s.x,y:sigY+75,size:9,font:bold,color:grey});
    if(s.show){
      const img=await embedSignature(doc,s.file);
      if(img){
        const scale=Math.min(85/img.width,38/img.height);
        page.drawImage(img,{x:s.x,y:sigY+28,width:img.width*scale,height:img.height*scale});
      }
    }
    page.drawText(String(s.name||''),{x:s.x,y:sigY+10,size:8,font:normal});
  }

  page.drawText(`Status: ${request.status} · Revision ${request.revision}`,{x:42,y:28,size:8,font:normal,color:grey});
  await fs.writeFile(outPath,await doc.save());
  return outPath;
}

export async function buildFormPdf(args) {
  if(PDF_MODE==='google-sheet') return buildGoogleSheetFormPdf(args);
  return buildMockFormPdf(args);
}
