import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const SIGNATURE_DIR=process.env.SIGNATURE_DIR || '/data/signatures';

function money(n){ return 'Rp ' + Number(n||0).toLocaleString('id-ID'); }
function dateText(v){ return String(v||'').slice(0,10); }

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
      ['Payment Date',dateText(item.paymentDate || item.payment_date)],
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
        page.drawImage(image,{x:(595-w)/2,y:(780-h)/2,w,h});
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

export async function buildFormPdf({request,items,outPath}) {
  await ensureParent(outPath);
  const doc=await PDFDocument.create();
  const page=doc.addPage([595,842]);
  const bold=await doc.embedFont(StandardFonts.HelveticaBold);
  const normal=await doc.embedFont(StandardFonts.Helvetica);
  const navy=rgb(0.04,0.22,0.41);
  const grey=rgb(.38,.42,.48);

  page.drawText('PT METROTECH INDONESIA',{x:42,y:795,size:12,font:bold,color:navy});
  page.drawText('EXPENSE REQUEST FORM',{x:42,y:770,size:20,font:bold,color:navy});
  page.drawText(`Request Date: ${dateText(request.request_date)}`,{x:395,y:798,size:9,font:normal});
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

  const x=[42,64,170,365,438,553];
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
    page.drawText(dateText(it.payment_date || it.paymentDate),{x:370,y:y+7,size:8,font:normal});
    page.drawText(money(it.amount),{x:445,y:y+7,size:8,font:normal});
    y-=rowH;
  });

  page.drawText('TOTAL',{x:365,y:y-4,size:10,font:bold});
  page.drawText(money(request.total),{x:445,y:y-4,size:10,font:bold,color:navy});

  const sigY=82;
  const sigCols=[
    {label:'Prepared By',name:request.employee_name,file:request.requestor_signature,show:true,x:68},
    {label:'Reviewed By',name:request.reviewer_name,file:request.reviewer_signature,
     show:['PENDING_APPROVAL','APPROVAL_REJECTED','APPROVED'].includes(request.status),x:252},
    {label:'Approved By',name:request.approver_name,file:request.approver_signature,
     show:request.status==='APPROVED',x:430}
  ];
  for(const s of sigCols){
    page.drawText(s.label,{x:s.x,y:sigY+75,size:9,font:bold,color:grey});
    if(s.show){
      const img=await embedSignature(doc,s.file);
      if(img){
        const scale=Math.min(85/img.width,38/img.height);
        page.drawImage(img,{x:s.x,y:sigY+28,w:img.width*scale,h:img.height*scale});
      }
    }
    page.drawText(String(s.name||''),{x:s.x,y:sigY+10,size:8,font:normal});
  }

  page.drawText(`Status: ${request.status} · Revision ${request.revision}`,{x:42,y:28,size:8,font:normal,color:grey});
  await fs.writeFile(outPath,await doc.save());
  return outPath;
}
