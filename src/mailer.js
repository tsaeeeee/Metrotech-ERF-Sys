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

function recipientList(value){
  const values=Array.isArray(value)?value:[value];
  return values
    .flatMap(item=>String(item||'').split(','))
    .map(item=>item.trim())
    .filter(Boolean);
}

function uniqueRecipients(values=[]){
  const seen=new Set();
  const result=[];
  for(const value of values){
    const email=String(value||'').trim();
    const key=email.toLowerCase();
    if(!email||seen.has(key)) continue;
    seen.add(key);
    result.push(email);
  }
  return result;
}

function finalApprovalAttachments(event,request,attachments=[]){
  if(event!=='FINAL_APPROVED') return [];
  const provided=Array.isArray(attachments)?attachments.filter(Boolean):[];
  if(provided.length) return provided;
  if(!request?.form_pdf_path) return [];
  return [{
    filename:`${String(request.ref_no||'approved-request')}.pdf`,
    path:request.form_pdf_path
  }];
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
  const toRecipients=uniqueRecipients(recipientList(to));
  const baseCc=recipientList(cc);
  const finalCc=event==='FINAL_APPROVED'
    ? uniqueRecipients([...baseCc,request?.reviewer_email,request?.approver_email])
    : uniqueRecipients(baseCc);

  const originalTo=toRecipients.join(',');
  const originalCc=finalCc.join(',');
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
  const mailAttachments=finalApprovalAttachments(event,request,attachments);
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
