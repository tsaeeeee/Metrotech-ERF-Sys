import nodemailer from 'nodemailer';
import fs from 'node:fs/promises';
import { getEmployee,logEmail } from './db.js';
import { getRuntimeAppSettings } from './settings.js';

const MAIL_GATEWAY_URL=String(process.env.MAIL_GATEWAY_URL||'').trim();
const MAIL_GATEWAY_SECRET=String(process.env.MAIL_GATEWAY_SECRET||'').trim();

function createTransport(settings){
  return nodemailer.createTransport({
    host:settings.smtpHost,
    port:Number(settings.smtpPort||587),
    secure:Boolean(settings.smtpSecure),
    auth:settings.smtpUser ? {user:settings.smtpUser,pass:settings.smtpPass} : undefined
  });
}

function gatewayReady(){
  return Boolean(MAIL_GATEWAY_URL && MAIL_GATEWAY_SECRET);
}

function smtpReady(settings){
  return Boolean(settings.smtpEnabled && settings.smtpHost && settings.mailFrom);
}

function mailReady(settings){
  return gatewayReady() || smtpReady(settings);
}

async function gatewayAttachments(attachments=[]){
  const result=[];
  for(const file of Array.isArray(attachments)?attachments:[]){
    if(!file) continue;
    let buffer=null;
    if(Buffer.isBuffer(file.content)) buffer=file.content;
    else if(file.path) buffer=await fs.readFile(file.path);
    if(!buffer) continue;
    result.push({
      filename:String(file.filename||'attachment.pdf'),
      mimeType:String(file.contentType||'application/pdf'),
      base64:buffer.toString('base64')
    });
  }
  return result;
}

async function sendViaGateway({to,cc='',subject,text,html,attachments=[]}){
  if(!gatewayReady())
    throw new Error('Mail gateway is not configured.');

  const payload={
    secret:MAIL_GATEWAY_SECRET,
    to:String(to||''),
    cc:String(cc||''),
    subject:String(subject||''),
    text:String(text||''),
    html:String(html||''),
    attachments:await gatewayAttachments(attachments)
  };

  const response=await fetch(MAIL_GATEWAY_URL,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),
    redirect:'follow',
    signal:AbortSignal.timeout(30000)
  });

  const raw=await response.text();
  let data;
  try{data=JSON.parse(raw)}
  catch{throw new Error(`Mail gateway returned invalid response (${response.status}).`)}

  if(!response.ok || !data?.ok)
    throw new Error(data?.error || `Mail gateway request failed (${response.status}).`);

  return data;
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

function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[char]));
}

function requestCode(request){
  return String(request?.request_type||'').toUpperCase()==='REIMBURSEMENT' ||
    String(request?.ref_no||'').startsWith('RRF-')
    ? 'RRF'
    : 'ERF';
}

function requestTypeLabel(request){
  return requestCode(request)==='RRF'?'Reimbursement':'Expense Request';
}

function formatMoney(value){
  const amount=Number(value||0);
  if(!Number.isFinite(amount)) return String(value||'-');
  return new Intl.NumberFormat('id-ID',{
    style:'currency',currency:'IDR',maximumFractionDigits:0
  }).format(amount).replace(/\s/g,' ');
}

function formatDate(value){
  if(!value) return '-';
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime())) return String(value).slice(0,10);
  return new Intl.DateTimeFormat('en-GB',{
    day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Jakarta'
  }).format(date);
}

function eventPresentation(event,request,fallbackText=''){
  const requestor=String(request?.employee_name||'The requestor');
  const reason=String(request?.last_rejection_reason||'').trim();
  const map={
    SUBMITTED:{
      title:'A new request needs your review',
      badge:'Pending Review',
      badgeBg:'#1d4ed8',
      message:`A new ${requestTypeLabel(request).toLowerCase()} has been submitted by ${requestor} and is waiting for your review.`,
      cta:'Review Request'
    },
    REVISED:{
      title:'A revised request needs your review',
      badge:'Pending Review',
      badgeBg:'#7c3aed',
      message:`${requestor} submitted revision ${Number(request?.revision||1)} of this request. Please review the updated information.`,
      cta:'Review Request'
    },
    RECALLED:{
      title:'A request has been recalled',
      badge:'Recalled',
      badgeBg:'#475569',
      message:'This request has been recalled by the requestor and is no longer active in the current approval flow.',
      cta:'View Request'
    },
    REVIEW_APPROVED:{
      title:'A request is awaiting your approval',
      badge:'Pending Approval',
      badgeBg:'#b45309',
      message:'This request has completed the review stage and is now ready for your final approval.',
      cta:'Open for Approval'
    },
    REVIEW_REJECTED:{
      title:'Your request has been rejected',
      badge:'Rejected',
      badgeBg:'#b91c1c',
      message:reason
        ? `The request was rejected during the review stage. Remarks: ${reason}`
        : 'The request was rejected during the review stage. Please check the remarks in the ERF system and revise it if necessary.',
      cta:'View Request'
    },
    APPROVAL_REJECTED:{
      title:'Your request has been rejected',
      badge:'Rejected',
      badgeBg:'#b91c1c',
      message:reason
        ? `The request was rejected during the approval stage. Remarks: ${reason}`
        : 'The request was rejected during the approval stage. Please check the remarks in the ERF system and revise it if necessary.',
      cta:'View Request'
    },
    FINAL_APPROVED:{
      title:'Your request has been fully approved',
      badge:'Approved',
      badgeBg:'#15803d',
      message:'Your request has completed all approval stages. The final approved PDF form is attached to this email for your reference.',
      cta:'View Approved Request'
    }
  };
  return map[event]||{
    title:'ERF workflow notification',
    badge:String(request?.status||'Notification').replaceAll('_',' '),
    badgeBg:'#155da8',
    message:String(fallbackText||'There is an update to this request.'),
    cta:'Open ERF System'
  };
}

function workflowSubject(event,request,fallback=''){
  const ref=String(request?.ref_no||'').trim();
  const code=requestCode(request);
  const labels={
    SUBMITTED:'Review Required',
    REVISED:'Review Required',
    RECALLED:'Request Recalled',
    REVIEW_APPROVED:'Approval Required',
    REVIEW_REJECTED:'Request Rejected',
    APPROVAL_REJECTED:'Request Rejected',
    FINAL_APPROVED:'Final Approved'
  };
  if(ref && labels[event]) return `[${code}] ${labels[event]} — ${ref}`;
  return fallback||`[${code}] ERF Workflow Notification`;
}

async function resolveRecipientName(email){
  try{
    const employee=await getEmployee(email);
    if(employee?.name) return employee.name;
  }catch{}
  const local=String(email||'').split('@')[0].replace(/[._-]+/g,' ').trim();
  if(!local) return 'there';
  return local.replace(/\b\w/g,char=>char.toUpperCase());
}

function summaryRows(request,presentation){
  const rows=[
    ['Reference No',request?.ref_no||'-'],
    ['Request Type',requestTypeLabel(request)],
    ['Requestor',request?.employee_name||'-'],
    ['Department',request?.department||'-'],
    ['Division',request?.division||'-'],
    ['Total Amount',formatMoney(request?.total)],
    ['Request Date',formatDate(request?.request_date)],
    ['Current Status',presentation.badge]
  ];
  if(Number(request?.revision||1)>1) rows.splice(2,0,['Revision',String(request.revision)]);
  return rows;
}

function buildWorkflowHtml({event,request,recipientName,settings,text}){
  const presentation=eventPresentation(event,request,text);
  const rows=summaryRows(request,presentation);
  const appUrl=String(settings.appBaseUrl||'').replace(/\/$/,'');
  const preheader=`${presentation.title} — ${String(request?.ref_no||'ERF request')}`;
  const attachmentNote=event==='FINAL_APPROVED'
    ? `<tr><td style="padding:18px 22px 0 22px;">
         <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0b162b;border:1px solid #263652;border-radius:12px;">
           <tr><td style="padding:14px 16px;color:#b8c6dc;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;">
             <strong style="color:#ffffff;">Final approved form attached</strong><br>
             The signed final PDF is included with this email for your records.
           </td></tr>
         </table>
       </td></tr>`
    : '';

  const cta=appUrl
    ? `<tr><td align="center" style="padding:26px 22px 4px 22px;">
         <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#2f9eea;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;padding:13px 24px;border-radius:9px;">${escapeHtml(presentation.cta)}</a>
       </td></tr>`
    : '';

  const detailRows=rows.map(([label,value],index)=>`
    <tr>
      <td style="padding:${index===0?'17px':'9px'} 18px 9px 18px;width:42%;color:#7f91ad;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;vertical-align:top;${index?'border-top:1px solid #1e2c45;':''}">${escapeHtml(label)}</td>
      <td style="padding:${index===0?'17px':'9px'} 18px 9px 4px;color:#f5f8fc;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;line-height:18px;vertical-align:top;text-align:right;${index?'border-top:1px solid #1e2c45;':''}">${escapeHtml(value)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(presentation.title)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#eef2f7;">
    <tr>
      <td align="center" style="padding:42px 14px;">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#101b31;border-radius:18px;overflow:hidden;box-shadow:0 12px 34px rgba(15,39,68,.15);">
          <tr><td style="height:5px;background:#2f9eea;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="padding:34px 28px 10px 28px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:27px;line-height:32px;font-weight:800;color:#45b8ff;letter-spacing:-.5px;">METROTECH</div>
              <div style="margin-top:7px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:#72839f;">Expense Request System</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 38px 0 38px;font-family:Arial,Helvetica,sans-serif;color:#d8e1ef;font-size:15px;line-height:24px;">
              Hello <strong style="color:#ffffff;">${escapeHtml(recipientName)}</strong>,
            </td>
          </tr>
          <tr>
            <td style="padding:16px 38px 0 38px;">
              <span style="display:inline-block;background:${presentation.badgeBg};color:#ffffff;border-radius:999px;padding:6px 11px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;line-height:14px;letter-spacing:.2px;">${escapeHtml(presentation.badge)}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 38px 0 38px;font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:800;line-height:31px;color:#ffffff;">${escapeHtml(presentation.title)}</td>
          </tr>
          <tr>
            <td style="padding:12px 38px 24px 38px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:23px;color:#aebbd0;">${escapeHtml(presentation.message)}</td>
          </tr>
          <tr>
            <td style="padding:0 22px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#091327;border:1px solid #263652;border-radius:14px;overflow:hidden;">
                ${detailRows}
              </table>
            </td>
          </tr>
          ${attachmentNote}
          ${cta}
          <tr>
            <td style="padding:28px 38px 12px 38px;">
              <div style="height:1px;background:#25344e;font-size:0;line-height:0;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 38px 32px 38px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:#71819b;">
              This is an automated notification from Metrotech Expense Request System.<br>
              Please do not reply to this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildTestHtml(){
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#eef2f7;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef2f7;width:100%;">
<tr><td align="center" style="padding:42px 14px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#101b31;border-radius:18px;overflow:hidden;">
<tr><td style="height:5px;background:#2f9eea;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td align="center" style="padding:34px 28px 8px 28px;font-family:Arial,Helvetica,sans-serif;font-size:27px;font-weight:800;color:#45b8ff;">METROTECH</td></tr>
<tr><td align="center" style="padding:0 28px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#72839f;">Expense Request System</td></tr>
<tr><td align="center" style="padding:28px 32px 8px 32px;"><span style="display:inline-block;background:#15803d;color:#fff;border-radius:999px;padding:6px 12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;">Mail Gateway Connected</span></td></tr>
<tr><td align="center" style="padding:10px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:23px;font-weight:800;line-height:30px;color:#fff;">Email delivery is working</td></tr>
<tr><td align="center" style="padding:12px 42px 32px 42px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#aebbd0;">Email delivery has been verified successfully. Workflow notifications can now be delivered from the Metrotech Expense Request System.</td></tr>
<tr><td style="padding:0 38px;"><div style="height:1px;background:#25344e;font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td align="center" style="padding:22px 38px 30px 38px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:#71819b;">This is an automated test message. Please do not reply to this email.</td></tr>
</table>
</td></tr></table>
</body></html>`;
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
  if(!to) throw Object.assign(new Error('Test recipient is required.'),{status:400});

  const subject='Metrotech ERF Email Delivery Test';
  const text='Email delivery is working. This is a test message from Metrotech Expense Request System.';
  const html=buildTestHtml();

  if(gatewayReady()){
    await sendViaGateway({to,subject,text,html});
    return;
  }

  if(!smtpReady(settings))
    throw Object.assign(new Error('Email delivery is not fully configured yet.'),{status:409});

  const transport=createTransport(settings);
  await transport.verify();
  await transport.sendMail({
    from:{name:settings.mailSenderName||'Metrotech Expense Approval System',address:settings.mailFrom},
    to,subject,text,html
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

  const mailSubject=workflowSubject(event,request,subject);
  const recipientName=await resolveRecipientName(toRecipients[0]||toText);
  const plainText=`${text}\n\nReference: ${request?.ref_no||'-'}\nRequest Type: ${requestTypeLabel(request)}\nRequestor: ${request?.employee_name||'-'}\nTotal: ${formatMoney(request?.total)}\n\nThis is an automated notification. Please do not reply to this email.`;
  const html=buildWorkflowHtml({event,request,recipientName,settings,text});

  if(!mailReady(settings)){
    console.log('[MAIL:CONSOLE]',{
      event,to:toText,cc:ccText,originalTo,originalCc,subject:mailSubject,overridden:Boolean(override)
    });
    await logEmail({
      requestId:request?.id||null,refNo:request?.ref_no||null,event,to:toText,cc:ccText,
      status:'CONSOLE',error:''
    });
    return;
  }

  const mailAttachments=finalApprovalAttachments(event,request,attachments);
  try{
    if(gatewayReady()){
      await sendViaGateway({
        to:toText,
        cc:ccText,
        subject:mailSubject,
        text:plainText,
        html,
        attachments:mailAttachments
      });
    }else{
      const transport=createTransport(settings);
      await transport.sendMail({
        from:{name:settings.mailSenderName||'Metrotech Expense Approval System',address:settings.mailFrom},
        to:toText,
        cc:ccText||undefined,
        subject:mailSubject,
        text:plainText,
        html,
        attachments:mailAttachments
      });
    }
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
