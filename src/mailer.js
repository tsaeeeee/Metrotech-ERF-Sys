import nodemailer from 'nodemailer';
import { logEmail } from './db.js';

function configured() {
  return String(process.env.MAIL_MODE || 'console').toLowerCase()==='smtp' &&
    Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

export async function sendWorkflowMail({event,request,to,cc='',subject,text,attachments=[]}) {
  const originalTo=Array.isArray(to)?to.filter(Boolean).join(','):String(to||'');
  const originalCc=Array.isArray(cc)?cc.filter(Boolean).join(','):String(cc||'');
  const override=String(process.env.MAIL_OVERRIDE_TO||'').trim();
  const toText=override || originalTo;
  const ccText=override ? '' : originalCc;
  if(!toText) return;

  if(!configured()){
    console.log('[MAIL:CONSOLE]',{
      event,
      to:toText,
      cc:ccText,
      originalTo,
      originalCc,
      subject,
      overridden:Boolean(override)
    });
    await logEmail({
      requestId:request?.id||null,refNo:request?.ref_no||null,event,to:toText,cc:ccText,
      status:'CONSOLE',error:''
    });
    return;
  }

  const transport=nodemailer.createTransport({
    host:process.env.SMTP_HOST,
    port:Number(process.env.SMTP_PORT||587),
    secure:String(process.env.SMTP_SECURE||'false').toLowerCase()==='true',
    auth:process.env.SMTP_USER ? {user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} : undefined
  });

  try{
    await transport.sendMail({
      from:{name:process.env.MAIL_SENDER_NAME||'Metrotech Expense Approval System',address:process.env.MAIL_FROM},
      to:toText,cc:ccText||undefined,subject,
      text:`${text}\n\nThis is an automated notification. Please do not reply to this email.`,
      attachments
    });
    await logEmail({requestId:request?.id||null,refNo:request?.ref_no||null,event,to:toText,cc:ccText,status:'SENT',error:''});
  }catch(e){
    await logEmail({requestId:request?.id||null,refNo:request?.ref_no||null,event,to:toText,cc:ccText,status:'ERROR',error:e.message});
    console.error('Mail send failed:',e.message);
  }
}
