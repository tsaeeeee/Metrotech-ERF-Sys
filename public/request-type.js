// Request type extension for the Requestor form.
// Loaded after app.js by src/server.js so the existing ERF UI can stay unchanged.

let rtRequestType='EXPENSE';
let signaturePreviewObjectUrl=null;

function toastDismiss(node){
  if(!node) return;
  node.classList.remove('show');
  node.classList.add('hide');
  window.setTimeout(()=>node.remove(),180);
}

function toastHost(){
  rtInjectStyles();
  let host=document.getElementById('toastHost');
  if(!host){
    host=document.createElement('div');
    host.id='toastHost';
    host.className='ui-toast-host';
    host.setAttribute('aria-live','polite');
    host.setAttribute('aria-atomic','false');
    document.body.appendChild(host);
  }
  return host;
}

msg=function(text,type='ok'){
  const host=toastHost();
  const isError=type==='err';
  const toast=document.createElement('div');
  toast.className=`ui-toast ${isError?'err':'ok'}`;
  toast.setAttribute('role',isError?'alert':'status');

  const icon=document.createElement('div');
  icon.className='ui-toast-icon';
  icon.textContent=isError?'!':'✓';

  const copy=document.createElement('div');
  copy.className='ui-toast-copy';
  const title=document.createElement('strong');
  title.textContent=isError?'Action failed':'Success';
  const body=document.createElement('span');
  body.textContent=String(text||'');
  copy.append(title,body);

  const close=document.createElement('button');
  close.className='ui-toast-close';
  close.type='button';
  close.setAttribute('aria-label','Dismiss notification');
  close.textContent='×';
  close.addEventListener('click',()=>toastDismiss(toast));

  toast.append(icon,copy,close);
  host.appendChild(toast);
  requestAnimationFrame(()=>toast.classList.add('show'));
  window.setTimeout(()=>toastDismiss(toast),isError?6500:4800);
  return toast;
};

clearMsg=function(){
  const legacy=$('#msg');
  if(legacy) legacy.innerHTML='';
  document.querySelectorAll('#toastHost .ui-toast').forEach(toastDismiss);
};

function rtNormalizeType(value){
  return String(value||'EXPENSE').trim().toUpperCase()==='REIMBURSEMENT'
    ? 'REIMBURSEMENT'
    : 'EXPENSE';
}

function rtIsReimbursement(){
  return rtRequestType==='REIMBURSEMENT';
}

function sigHasDigitalSignature(){
  return Boolean(String(currentEmployee?.signature_file||'').trim());
}

function sigRequireWorkflowSignature(action='perform this action'){
  if(sigHasDigitalSignature()) return true;
  msg(`Digital signature required. Upload your signature in My Profile before you can ${action}.`,'err');
  return false;
}

function rtInjectStyles(){
  if(document.getElementById('requestTypeStyles')) return;
  const style=document.createElement('style');
  style.id='requestTypeStyles';
  style.textContent=`
    .request-type-row{
      display:flex;align-items:center;justify-content:space-between;gap:18px;
      margin:14px 0 18px;padding:14px 16px;border:1px solid #e2e8f0;
      border-radius:14px;background:#f8fafc;
    }
    .request-type-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
    .request-type-copy strong{font-size:14px;color:#0f2744}
    .request-type-copy small{color:#64748b;font-size:12px}
    .request-type-control{
      display:grid;grid-template-columns:1fr 1fr;align-items:center;
      width:340px;max-width:100%;padding:4px;
      border-radius:999px;background:#155da8;
      box-shadow:inset 0 0 0 1px rgba(15,39,68,.08);
    }
    .request-type-option{
      appearance:none;border:0;background:transparent;color:#fff;
      min-height:40px;padding:8px 18px;border-radius:999px;
      font:inherit;font-size:12px;font-weight:800;line-height:1.15;
      white-space:nowrap;cursor:pointer;transition:background .18s ease,color .18s ease,box-shadow .18s ease,transform .12s ease;
    }
    .request-type-option:hover:not(:disabled){background:rgba(255,255,255,.11)}
    .request-type-option:active:not(:disabled){transform:scale(.985)}
    .request-type-option.active{
      background:#fff;color:#155da8;
      box-shadow:0 2px 7px rgba(15,39,68,.18);
    }
    .request-type-option:disabled{cursor:not-allowed;opacity:.66}
    .request-type-control.is-locked{opacity:.76}
    .evidence-mode-note{display:block;margin-top:5px;font-size:11px;color:#64748b}
    .signature-required-notice{
      display:flex;align-items:center;justify-content:space-between;gap:14px;
      margin:0 0 18px;padding:13px 15px;border:1px solid #f59e0b33;
      border-radius:12px;background:#fff8e7;color:#7c4a03;
    }
    .signature-required-notice strong{display:block;font-size:13px;margin-bottom:2px;color:#7c4a03}
    .signature-required-notice span{font-size:12px;line-height:1.4}
    .signature-required-notice button{
      border:0;border-radius:999px;padding:8px 13px;background:#155da8;color:#fff;
      font:inherit;font-size:12px;font-weight:800;white-space:nowrap;cursor:pointer;
    }
    .signature-decision-note{
      margin:0 0 12px;padding:10px 12px;border-radius:10px;background:#fff8e7;
      color:#7c4a03;font-size:12px;line-height:1.45;
    }
    .signature-decision-note button{
      margin-left:6px;border:0;background:transparent;color:#155da8;font:inherit;
      font-weight:800;text-decoration:underline;cursor:pointer;
    }
    .signature-mini-preview{
      min-height:92px;
      margin:7px 0 10px;
      padding:9px 11px;
      display:flex;
      align-items:center;
      gap:12px;
      border:1px solid #e2e8f0;
      border-radius:11px;
      background:#f8fafc;
    }
    .signature-mini-preview img{
      display:block;
      width:auto;
      max-width:210px;
      max-height:72px;
      object-fit:contain;
      padding:5px 7px;
      border:1px solid #e2e8f0;
      border-radius:8px;
      background:#fff;
    }
    .signature-preview-empty{
      color:#98a2b3;
      font-size:11.5px;
      line-height:1.4;
    }
    .signature-preview-caption{
      color:#667085;
      font-size:10.5px;
      font-weight:700;
      line-height:1.35;
    }
    .decision-action-loading{
      display:inline-flex!important;
      align-items:center;
      justify-content:center;
      gap:8px;
    }
    .decision-spinner{
      width:14px;
      height:14px;
      flex:0 0 14px;
      border:2px solid currentColor;
      border-right-color:transparent;
      border-radius:50%;
      animation:decision-spin .7s linear infinite;
    }
    .evidence-file-link{
      color:inherit;
      text-decoration:none;
      cursor:pointer;
    }
    .evidence-file-link:hover{
      color:#155da8;
      text-decoration:underline;
    }
    .ui-toast-host{
      position:fixed;
      top:70px;
      right:18px;
      z-index:120;
      width:min(360px,calc(100vw - 28px));
      display:flex;
      flex-direction:column;
      gap:10px;
      pointer-events:none;
    }
    .ui-toast{
      pointer-events:auto;
      display:grid;
      grid-template-columns:30px minmax(0,1fr) 24px;
      gap:10px;
      align-items:start;
      padding:12px 11px 12px 12px;
      border:1px solid rgba(148,163,184,.30);
      border-radius:14px;
      background:rgba(255,255,255,.94);
      box-shadow:0 16px 42px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.08);
      backdrop-filter:blur(18px) saturate(1.15);
      -webkit-backdrop-filter:blur(18px) saturate(1.15);
      opacity:0;
      transform:translateX(26px) scale(.985);
      transition:opacity .18s ease,transform .18s ease;
    }
    .ui-toast.show{opacity:1;transform:translateX(0) scale(1)}
    .ui-toast.hide{opacity:0;transform:translateX(20px) scale(.985)}
    .ui-toast-icon{
      width:28px;height:28px;border-radius:9px;display:grid;place-items:center;
      font-size:13px;font-weight:900;
    }
    .ui-toast.ok .ui-toast-icon{background:#ecfdf3;color:#067647}
    .ui-toast.err .ui-toast-icon{background:#fff1f0;color:#b42318}
    .ui-toast-copy{min-width:0;padding-top:1px}
    .ui-toast-copy strong{display:block;font-size:12px;color:#172033;margin-bottom:2px}
    .ui-toast-copy span{display:block;font-size:11.5px;line-height:1.42;color:#475467;word-break:break-word}
    .ui-toast-close{
      width:24px;height:24px;padding:0;border:0;border-radius:7px;background:transparent;
      color:#98a2b3;font:18px/1 Arial,sans-serif;cursor:pointer;
    }
    .ui-toast-close:hover{background:#f2f4f7;color:#475467}
    @keyframes decision-spin{
      to{transform:rotate(360deg)}
    }
    @media(max-width:700px){
      .request-type-row{align-items:flex-start;flex-direction:column}
      .request-type-control{width:100%}
      .request-type-option{min-height:38px;padding:8px 10px;font-size:11.5px}
      .signature-required-notice{align-items:flex-start;flex-direction:column}
      .signature-mini-preview{align-items:flex-start;flex-direction:column}
      .signature-mini-preview img{max-width:100%}
      .ui-toast-host{top:62px;left:10px;right:10px;width:auto}
    }
  `;
  document.head.appendChild(style);
}

function sigSyncWorkflowUi(){
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  rtInjectStyles();

  const missing=!sigHasDigitalSignature();
  const dashboard=$('#workflowDashboard');
  let notice=$('#signatureRequiredNotice');

  if(missing && dashboard){
    if(!notice){
      notice=document.createElement('div');
      notice.id='signatureRequiredNotice';
      notice.className='signature-required-notice';
      notice.innerHTML=`
        <div>
          <strong>Digital signature required</strong>
          <span>Upload your signature in My Profile before submitting, recalling, revising, reviewing, rejecting, or approving requests.</span>
        </div>
        <button type="button" onclick="openProfileModal()">Open My Profile</button>`;
      dashboard.prepend(notice);
    }
  }else{
    notice?.remove();
  }

  if(currentEmployee.role==='REQUESTOR' && missing){
    const submit=$('#submitExpenseBtn');
    if(submit) submit.disabled=true;
  }

  const decisionPanel=$('#decisionPanel');
  let decisionNote=$('#signatureDecisionNote');
  const decisionVisible=decisionPanel && !decisionPanel.classList.contains('hidden');
  if(missing && decisionVisible && ['REVIEWER','APPROVER'].includes(currentEmployee.role)){
    if(!decisionNote){
      decisionNote=document.createElement('div');
      decisionNote.id='signatureDecisionNote';
      decisionNote.className='signature-decision-note';
      decisionNote.innerHTML='Upload your digital signature before taking a decision.<button type="button" onclick="openProfileModal()">Open My Profile</button>';
      decisionPanel.prepend(decisionNote);
    }
    if($('#approveBtn')) $('#approveBtn').disabled=true;
    if($('#rejectBtn')) $('#rejectBtn').disabled=true;
  }else{
    decisionNote?.remove();
  }
}

function signatureEnsurePreview(){
  rtInjectStyles();
  const field=document.querySelector('#profileForm .signature-upload');
  if(!field) return null;
  let preview=$('#signatureMiniPreview');
  if(preview) return preview;

  preview=document.createElement('div');
  preview.id='signatureMiniPreview';
  preview.className='signature-mini-preview';
  preview.innerHTML=`
    <img id="signaturePreviewImage" class="hidden" alt="Signature preview">
    <div>
      <div id="signaturePreviewEmpty" class="signature-preview-empty">No signature uploaded yet.</div>
      <div id="signaturePreviewCaption" class="signature-preview-caption hidden"></div>
    </div>`;

  const picker=field.querySelector('.evidence-picker');
  if(picker) field.insertBefore(preview,picker);
  else field.appendChild(preview);
  return preview;
}

function signatureClearObjectUrl(){
  if(signaturePreviewObjectUrl){
    URL.revokeObjectURL(signaturePreviewObjectUrl);
    signaturePreviewObjectUrl=null;
  }
}

function signatureShowPreview(src,caption){
  signatureEnsurePreview();
  const image=$('#signaturePreviewImage');
  const empty=$('#signaturePreviewEmpty');
  const label=$('#signaturePreviewCaption');
  if(!image || !empty || !label) return;

  image.onload=()=>{
    image.classList.remove('hidden');
    empty.classList.add('hidden');
    label.textContent=caption||'Current signature';
    label.classList.remove('hidden');
  };
  image.onerror=()=>{
    image.removeAttribute('src');
    image.classList.add('hidden');
    label.classList.add('hidden');
    empty.textContent='Signature preview is unavailable.';
    empty.classList.remove('hidden');
  };
  image.src=src;
}

function signatureRefreshStoredPreview(){
  signatureClearObjectUrl();
  signatureEnsurePreview();
  const image=$('#signaturePreviewImage');
  const empty=$('#signaturePreviewEmpty');
  const label=$('#signaturePreviewCaption');
  if(!image || !empty || !label) return;

  image.onload=null;
  image.onerror=null;
  image.removeAttribute('src');
  image.classList.add('hidden');
  label.classList.add('hidden');

  if(!sigHasDigitalSignature()){
    empty.textContent='No signature uploaded yet.';
    empty.classList.remove('hidden');
    return;
  }

  empty.textContent='Loading current signature…';
  empty.classList.remove('hidden');
  signatureShowPreview(`/api/profile/signature?t=${Date.now()}`,'Current signature');
}

const sigOriginalOpenProfileModal=openProfileModal;
openProfileModal=function(...args){
  const result=sigOriginalOpenProfileModal(...args);
  if(currentEmployee && currentEmployee.role!=='ADMIN') signatureRefreshStoredPreview();
  return result;
};

document.addEventListener('change',e=>{
  if(e.target.id!=='profileSignature') return;
  const file=e.target.files?.[0];
  if(!file){
    signatureRefreshStoredPreview();
    return;
  }

  signatureClearObjectUrl();
  signaturePreviewObjectUrl=URL.createObjectURL(file);
  signatureShowPreview(signaturePreviewObjectUrl,'Selected replacement');
});

function rtSetRequestType(type){
  if(revisionTarget) return;
  rtRequestType=rtNormalizeType(type);
  rtApplyUi();
  syncAddButton();
}

function rtEnsureControl(){
  if(currentEmployee?.role!=='REQUESTOR') return;
  const form=$('#requestForm');
  if(!form) return;
  rtInjectStyles();

  // Production ERF is ERF-only. Keep legacy reimbursement records readable,
  // but do not expose a request-type selector for new submissions.
  if(!revisionTarget) rtRequestType='EXPENSE';
  $('#requestTypeRow')?.remove();

  rtApplyUi();
}

function rtApplyUi(){
  if(currentEmployee?.role!=='REQUESTOR') return;

  const expenseButton=$('#requestTypeExpenseLabel');
  const reimbursementButton=$('#requestTypeReimbursementLabel');
  const control=$('#requestTypeControl');
  const locked=Boolean(revisionTarget);

  if(expenseButton){
    expenseButton.classList.toggle('active',!rtIsReimbursement());
    expenseButton.setAttribute('aria-pressed',String(!rtIsReimbursement()));
    expenseButton.disabled=locked;
  }
  if(reimbursementButton){
    reimbursementButton.classList.toggle('active',rtIsReimbursement());
    reimbursementButton.setAttribute('aria-pressed',String(rtIsReimbursement()));
    reimbursementButton.disabled=locked;
  }
  control?.classList.toggle('is-locked',locked);

  const hint=$('#requestTypeHint');
  if(hint){
    hint.textContent=revisionTarget
      ? 'Request type is locked for this revision.'
      : rtIsReimbursement()
        ? 'Reimbursement requires evidence for every payment.'
        : 'Evidence is optional for Expense Request.';
  }

  if(!revisionTarget){
    $('#requestFormTitle').textContent=rtIsReimbursement()?'Reimbursement Form':'Expense Request Form';
    $('#submitExpenseBtn').textContent=rtIsReimbursement()?'Submit Reimbursement':'Submit Expense';
  }

  const evidenceLabel=document.querySelector('#requestForm .evidence-field > label');
  if(evidenceLabel) evidenceLabel.textContent=rtIsReimbursement()?'Evidence *':'Evidence';

  const evidenceField=document.querySelector('#requestForm .evidence-field');
  if(evidenceField){
    let note=$('#evidenceModeNote');
    if(!note){
      note=document.createElement('small');
      note.id='evidenceModeNote';
      note.className='evidence-mode-note';
      evidenceField.appendChild(note);
    }
    note.textContent=rtIsReimbursement()
      ? 'Required for reimbursement.'
      : 'Optional for expense request.';
  }

  sigSyncWorkflowUi();
}

const rtOriginalLoadMe=loadMe;
loadMe=async function(...args){
  const result=await rtOriginalLoadMe(...args);
  if(currentEmployee?.role==='REQUESTOR') rtEnsureControl();
  sigSyncWorkflowUi();
  return result;
};

syncAddButton=function(){
  const hasEvidence=selectedFiles().length>0 || editingPaymentEvidence().length>0;
  const baseValid=$('#category').value.trim() && $('#purpose').value.trim() && $('#paymentDate').value &&
    Number($('#amount').value)>0;
  const valid=baseValid && (!rtIsReimbursement() || hasEvidence);
  $('#addPaymentBtn').disabled=!valid;
};

addPayment=function(){
  clearMsg();
  const files=selectedFiles();
  const previous=editingIndex>=0 ? payments[editingIndex] : null;
  const evidence=files.length ? files : (previous?.evidence||[]);
  const x={
    category:$('#category').value.trim(),
    purpose:$('#purpose').value.trim(),
    paymentDate:$('#paymentDate').value,
    amount:Math.round(Number($('#amount').value)),
    evidence,
    sourceLineNo:previous?.sourceLineNo||null
  };

  if(!x.category||!x.purpose||!x.paymentDate||!x.amount)
    return msg('Complete all payment fields first.','err');
  if(rtIsReimbursement()&&!x.evidence.length)
    return msg('Evidence is required for every reimbursement payment.','err');

  if(editingIndex>=0){
    payments[editingIndex]=x;
    editingIndex=-1;
    $('#addPaymentBtn').textContent='+ Add Payment';
  }else{
    if(payments.length>=16) return msg('Maximum 16 payments per request.','err');
    payments.push(x);
  }
  resetPaymentForm();
  renderPayments();
  sigSyncWorkflowUi();
};

const rtOriginalStartRevision=startRevision;
startRevision=async function(id){
  await rtOriginalStartRevision(id);
  if(!revisionTarget) return;
  try{
    const data=await api(`/api/requests/${id}`);
    rtRequestType=rtNormalizeType(data.request?.request_type);
  }catch{
    rtRequestType='EXPENSE';
  }
  rtEnsureControl();
  rtApplyUi();
};

const rtOriginalCancelRevision=cancelRevision;
cancelRevision=function(){
  rtOriginalCancelRevision();
  rtRequestType='EXPENSE';
  rtEnsureControl();
  rtApplyUi();
};

const sigOriginalRecallRequest=recallRequest;
recallRequest=async function(...args){
  if(!sigRequireWorkflowSignature('recall this request')) return;
  return sigOriginalRecallRequest(...args);
};

const sigOriginalSendDecision=sendDecision;
sendDecision=async function(decision){
  const rejecting=String(decision).toUpperCase()==='REJECT';
  const role=currentEmployee?.role;
  const action=role==='REVIEWER'
    ? (rejecting?'reject this request':'review and approve this request')
    : (rejecting?'reject this request':'approve this request');

  if(!sigRequireWorkflowSignature(action)) return;

  rtInjectStyles();

  const approveBtn=$('#approveBtn');
  const rejectBtn=$('#rejectBtn');
  const activeBtn=rejecting?rejectBtn:approveBtn;
  const requestId=currentDetailId;
  const refNo=String($('#detailRef')?.textContent||'Request').trim()||'Request';
  let nextApprover='';

  if(role==='REVIEWER' && !rejecting && requestId){
    try{
      const data=await api(`/api/requests/${encodeURIComponent(requestId)}`);
      const resolved=workflowAssigneeName(data?.request,'approver');
      if(resolved!=='—') nextApprover=resolved;
    }catch{}
  }

  if(activeBtn){
    activeBtn.classList.add('decision-action-loading');
    activeBtn.setAttribute('aria-busy','true');
    activeBtn.innerHTML=
      `<span class="decision-spinner" aria-hidden="true"></span>${rejecting?'Rejecting…':'Approving…'}`;
  }

  if(approveBtn) approveBtn.disabled=true;
  if(rejectBtn) rejectBtn.disabled=true;

  try{
    const result=await sigOriginalSendDecision(decision);
    if(role==='REVIEWER' && !rejecting && nextApprover){
      clearMsg();
      msg(`${refNo} approved by Reviewer and forwarded to ${nextApprover} for final approval.`,'ok');
    }
    return result;
  }finally{
    if(approveBtn){
      approveBtn.classList.remove('decision-action-loading');
      approveBtn.removeAttribute('aria-busy');
      approveBtn.textContent='Approve';
    }

    if(rejectBtn){
      rejectBtn.classList.remove('decision-action-loading');
      rejectBtn.removeAttribute('aria-busy');
      rejectBtn.textContent='Reject';
    }
  }
};

const sigOriginalSyncRejectButton=syncRejectButton;
syncRejectButton=function(...args){
  sigOriginalSyncRejectButton(...args);
  if(!sigHasDigitalSignature() && $('#rejectBtn')) $('#rejectBtn').disabled=true;
};

const evidencePreviewUrls=new WeakMap();

function evidencePreviewUrl(file){
  if(typeof File==='undefined' || !(file instanceof File)) return '';
  let url=evidencePreviewUrls.get(file);
  if(!url){
    url=URL.createObjectURL(file);
    evidencePreviewUrls.set(file,url);
  }
  return url;
}

function evidenceSyncPaymentLinks(){
  const rows=[...document.querySelectorAll('#paymentBody tr')];
  rows.forEach((row,i)=>{
    const payment=payments[i];
    if(!payment) return;
    const cell=row.children?.[4];
    if(!cell) return;

    cell.innerHTML=(payment.evidence||[]).map(file=>{
      const name=esc(file?.name||'Evidence');
      if(typeof File!=='undefined' && file instanceof File){
        const href=evidencePreviewUrl(file);
        return `<a class="file-chip evidence-file-link" href="${href}" target="_blank" rel="noopener noreferrer" title="Open evidence in new tab">📎 ${name} ↗</a>`;
      }
      if(revisionTarget?.id){
        const href=`/api/requests/${encodeURIComponent(revisionTarget.id)}/evidence`;
        return `<a class="file-chip evidence-file-link" href="${href}" target="_blank" rel="noopener noreferrer" title="Open saved evidence in new tab">📎 ${name} ↗</a>`;
      }
      return `<span class="file-chip">📎 ${name}</span>`;
    }).join(' ');
  });
}

function evidenceSyncDetailLinks(){
  if(!currentDetailId) return;
  const href=`/api/requests/${encodeURIComponent(currentDetailId)}/evidence`;
  document.querySelectorAll('#detailItems .file-chip').forEach(chip=>{
    if(chip.tagName==='A') return;
    const link=document.createElement('a');
    link.className=`${chip.className} evidence-file-link`;
    link.href=href;
    link.target='_blank';
    link.rel='noopener noreferrer';
    link.title='Open evidence in new tab';
    link.innerHTML=`${chip.innerHTML} <span aria-hidden="true">↗</span>`;
    chip.replaceWith(link);
  });
}

function workflowAssigneeName(request,key){
  const name=String(request?.[`${key}_name`]||'').trim();
  if(name) return name;
  const email=String(request?.[`${key}_email`]||'').trim();
  return email||'—';
}

function workflowSyncDetailAssignees(data){
  const summary=$('#detailSummary');
  const request=data?.request;
  if(!summary || !request) return;

  summary.querySelectorAll('[data-workflow-assignee]').forEach(node=>node.remove());
  const rows=[
    ['Reviewer',workflowAssigneeName(request,'reviewer')],
    ['Approver',workflowAssigneeName(request,'approver')]
  ];
  summary.insertAdjacentHTML('beforeend',rows.map(([label,value])=>
    `<div data-workflow-assignee><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
  ).join(''));
}

async function workflowAssignmentNote(requestId){
  if(!requestId) return '';
  try{
    const data=await api(`/api/requests/${encodeURIComponent(requestId)}`);
    const request=data?.request;
    if(!request) return '';
    return ` Reviewer: ${workflowAssigneeName(request,'reviewer')}. Approver: ${workflowAssigneeName(request,'approver')}.`;
  }catch{
    return '';
  }
}

const sigOriginalOpenRequest=openRequest;
openRequest=async function(...args){
  const result=await sigOriginalOpenRequest(...args);
  sigSyncWorkflowUi();
  evidenceSyncDetailLinks();

  const id=args[0];
  if(id && !$('#detailModal')?.classList.contains('hidden')){
    try{
      const data=await api(`/api/requests/${encodeURIComponent(id)}`);
      workflowSyncDetailAssignees(data);
    }catch{}
  }

  return result;
};

const sigOriginalRenderPayments=renderPayments;
renderPayments=function(...args){
  const result=sigOriginalRenderPayments(...args);
  sigSyncWorkflowUi();
  evidenceSyncPaymentLinks();
  return result;
};

submitExpense=async function(){
  if(!payments.length) return;
  if(!sigRequireWorkflowSignature(revisionTarget?'resubmit this request':'submit this request')) return;
  if(rtIsReimbursement() && payments.some(x=>!(x.evidence||[]).length))
    return msg('Every reimbursement payment requires evidence before submission.','err');

  clearMsg();
  const btn=$('#submitExpenseBtn');
  btn.disabled=true;
  btn.textContent=revisionTarget?'Submitting Revision…':'Submitting…';

  try{
    const fd=new FormData();
    fd.append('requestType',rtRequestType);
    fd.append('items',JSON.stringify(payments.map(x=>({
      category:x.category,
      purpose:x.purpose,
      paymentDate:x.paymentDate,
      amount:x.amount,
      ...(x.sourceLineNo?{sourceLineNo:x.sourceLineNo}:{})
    }))));

    payments.forEach((x,i)=>{
      (x.evidence||[])
        .filter(file=>typeof File!=='undefined' && file instanceof File)
        .forEach(file=>fd.append(`evidence_${i}`,file,file.name));
    });

    const url=revisionTarget?`/api/requests/${revisionTarget.id}/revise`:'/api/requests';
    const r=await api(url,{method:'POST',body:fd});
    const assignmentNote=await workflowAssignmentNote(r.requestId);
    msg(`${r.refNo} ${revisionTarget?'revision submitted':'submitted'} successfully. Status: PENDING_REVIEW.${assignmentNote}`,'ok');
    cancelRevision();
    await loadMe();
  }catch(e){
    msg(e.message,'err');
    btn.textContent=revisionTarget
      ? 'Submit Revision'
      : rtIsReimbursement()?'Submit Reimbursement':'Submit Expense';
    btn.disabled=!payments.length || !sigHasDigitalSignature();
  }
};

// The stored form URL points to the merged request packet. In the split preview,
// render only page 1 on the left (the request form) and keep evidence on the right.
const splitOriginalRenderPdfDocument=renderPdfDocument;
renderPdfDocument=async function(url,targetSelector){
  if(targetSelector!=='#formPdfViewer')
    return splitOriginalRenderPdfDocument(url,targetSelector);

  const target=$(targetSelector);
  if(!target) return;
  if(!url){
    target.innerHTML='<div class="pdf-empty">Document unavailable.</div>';
    return;
  }

  target.innerHTML='<div class="pdf-loading">Loading document…</div>';
  try{
    const pdfjs=await getPdfJs();
    const task=pdfjs.getDocument({url,withCredentials:true});
    const pdf=await task.promise;
    const page=await pdf.getPage(1);
    target.innerHTML='';

    const baseViewport=page.getViewport({scale:1});
    const availableWidth=Math.max(260,target.clientWidth-24);
    const cssScale=Math.min(1.35,availableWidth/baseViewport.width);
    const pixelRatio=Math.min(window.devicePixelRatio||1,2);
    const renderViewport=page.getViewport({scale:cssScale*pixelRatio});

    const pageWrap=document.createElement('div');
    pageWrap.className='pdf-page';
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(renderViewport.width);
    canvas.height=Math.ceil(renderViewport.height);
    canvas.style.width=`${Math.ceil(renderViewport.width/pixelRatio)}px`;
    canvas.style.height=`${Math.ceil(renderViewport.height/pixelRatio)}px`;
    pageWrap.appendChild(canvas);
    target.appendChild(pageWrap);

    await page.render({
      canvasContext:canvas.getContext('2d',{alpha:false}),
      viewport:renderViewport
    }).promise;
  }catch(e){
    console.error('Form preview failed:',e);
    target.innerHTML='<div class="pdf-empty">Unable to preview this document.</div>';
  }
};

// The first loadMe() call starts at the end of the base app.js before this extension
// is evaluated, so run lightweight follow-up syncs once login state settles.
setTimeout(()=>{rtEnsureControl();sigSyncWorkflowUi();},350);
setTimeout(()=>{rtEnsureControl();sigSyncWorkflowUi();},1200);