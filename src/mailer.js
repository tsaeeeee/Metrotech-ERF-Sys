import nodemailer from 'nodemailer';
import { logEmail } from './db.js';
import { getRuntimeAppSettings } from './settings.js';

function createTransport(settings){
  return nodemailer.createTransport({
    host:settings.smtpHost,
    port:Number(settings.smtpPort||587),
    secure:Boolean(settings.smtpSecure),
    auth:settings.smtpUser ? {user:settings.smtpUser,pass:settings.smtpPass} : undefined
  });
}

function smtpReady(settings){
  return Boolean(settings.smtpEnabled && settings.smtpHost && settings.mailFrom);
}

function workflowPdfAttachments(request){
  const refNo=String(request?.ref_no||'request');
  const files=[];
  if(request?.form_pdf_path){
    files.push({
      filename:`${refNo}.pdf`,
      path:request.form_pdf_path
    });
  }
  if(request?.evidence_pdf_path){
    files.push({
      filename:`${refNo}-evidence.pdf`,
      path:request.evidence_pdf_path
    });
  }
  return files;
}

function mergeAttachments(request,attachments=[]){
  const merged=[...workflowPdfAttachments(request),...(Array.isArray(attachments)?attachments:[])];
  const seen=new Set();
  return merged.filter(item=>{
    const key=String(item?.path||item?.filename||'');
    if(!key||seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function testSmtp(to){
  const settings=await getRuntimeAppSettings();
  if(!smtpReady(settings))
    throw Object.assign(new Error('SMTP is not fully configured yet.'),{status:409});
  if(!to) throw Object.assign(new Error('Test recipient is required.'),{status:400});

  const transport=createTransport(settings);
  await transport.verify();
  await transport.sendMail({
    from:{name:settings.mailSenderName||'Metrotech Expense Approval System',address:settings.mailFrom},
    to,
    subject:'Metrotech ERF SMTP Test',
    text:'SMTP configuration is working. This is a test message from Metrotech Expense Request System.'
  });
}

export async function sendWorkflowMail({event,request,to,cc='',subject,text,attachments=[]}) {
  const settings=await getRuntimeAppSettings();
  const originalTo=Array.isArray(to)?to.filter(Boolean).join(','):String(to||'');
  const originalCc=Array.isArray(cc)?cc.filter(Boolean).join(','):String(cc||'');
  const override=String(settings.mailOverrideTo||'').trim();
  const toText=override||originalTo;
  const ccText=override?'':originalCc;
  if(!toText) return;

  if(!smtpReady(settings)){
    console.log('[MAIL:CONSOLE]',{
      event,to:toText,cc:ccText,originalTo,originalCc,subject,overridden:Boolean(override)
    });
    await logEmail({
      requestId:request?.id||null,refNo:request?.ref_no||null,event,to:toText,cc:ccText,
      status:'CONSOLE',error:''
    });
    return;
  }

  const transport=createTransport(settings);
  const mailAttachments=mergeAttachments(request,attachments);
  try{
    await transport.sendMail({
      from:{name:settings.mailSenderName||'Metrotech Expense Approval System',address:settings.mailFrom},
      to:toText,
      cc:ccText||undefined,
      subject,
      text:`${text}\n\nThis is an automated notification. Please do not reply to this email.`,
      attachments:mailAttachments
    });
    await logEmail({
      requestId:request?.id||null,refNo:request?.ref_no||null,event,to:toText,cc:ccText,status:'SENT',error:''
    });
  }catch(e){
    await logEmail({
      requestId:request?.id||null,refNo:request?.ref_no||null,event,to:toText,cc:ccText,status:'ERROR',error:e.message
    });
    console.error('Mail send failed:',e.message);
  }
}
