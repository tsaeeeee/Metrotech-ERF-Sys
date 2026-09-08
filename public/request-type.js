// Request type extension for the Requestor form.
// Loaded after app.js by src/server.js so the existing ERF UI can stay unchanged.

let rtRequestType='EXPENSE';

function rtNormalizeType(value){
  return String(value||'EXPENSE').trim().toUpperCase()==='REIMBURSEMENT'
    ? 'REIMBURSEMENT'
    : 'EXPENSE';
}

function rtIsReimbursement(){
  return rtRequestType==='REIMBURSEMENT';
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
    .request-type-copy{display:flex;flex-direction:column;gap:3px}
    .request-type-copy strong{font-size:14px;color:#0f2744}
    .request-type-copy small{color:#64748b;font-size:12px}
    .request-type-control{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:700;color:#64748b;white-space:nowrap}
    .request-type-control .active{color:#0f2744}
    .request-type-switch{position:relative;width:48px;height:26px;display:inline-block}
    .request-type-switch input{opacity:0;width:0;height:0}
    .request-type-slider{position:absolute;inset:0;cursor:pointer;background:#cbd5e1;border-radius:999px;transition:.18s ease}
    .request-type-slider:before{content:'';position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(15,23,42,.28);transition:.18s ease}
    .request-type-switch input:checked + .request-type-slider{background:#155da8}
    .request-type-switch input:checked + .request-type-slider:before{transform:translateX(22px)}
    .request-type-switch input:disabled + .request-type-slider{opacity:.55;cursor:not-allowed}
    .evidence-mode-note{display:block;margin-top:5px;font-size:11px;color:#64748b}
    @media(max-width:700px){
      .request-type-row{align-items:flex-start;flex-direction:column}
      .request-type-control{width:100%;justify-content:flex-end}
    }
  `;
  document.head.appendChild(style);
}

function rtEnsureControl(){
  if(currentEmployee?.role!=='REQUESTOR') return;
  const form=$('#requestForm');
  if(!form) return;
  rtInjectStyles();

  if(!$('#requestTypeRow')){
    const row=document.createElement('div');
    row.id='requestTypeRow';
    row.className='request-type-row';
    row.innerHTML=`
      <div class="request-type-copy">
        <strong>Request Type</strong>
        <small id="requestTypeHint">Choose Expense Request or Reimbursement before adding payments.</small>
      </div>
      <div class="request-type-control">
        <span id="requestTypeExpenseLabel">Expense Request</span>
        <label class="request-type-switch" title="Switch request type">
          <input id="requestTypeToggle" type="checkbox" aria-label="Use Reimbursement">
          <span class="request-type-slider"></span>
        </label>
        <span id="requestTypeReimbursementLabel">Reimbursement</span>
      </div>`;

    const paymentForm=form.querySelector('.payment-form');
    if(paymentForm) form.insertBefore(row,paymentForm);
    else form.appendChild(row);

    $('#requestTypeToggle').addEventListener('change',event=>{
      rtRequestType=event.target.checked?'REIMBURSEMENT':'EXPENSE';
      rtApplyUi();
      syncAddButton();
    });
  }

  rtApplyUi();
}

function rtApplyUi(){
  if(currentEmployee?.role!=='REQUESTOR') return;
  const toggle=$('#requestTypeToggle');
  if(toggle){
    toggle.checked=rtIsReimbursement();
    toggle.disabled=Boolean(revisionTarget);
  }

  $('#requestTypeExpenseLabel')?.classList.toggle('active',!rtIsReimbursement());
  $('#requestTypeReimbursementLabel')?.classList.toggle('active',rtIsReimbursement());

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
}

const rtOriginalLoadMe=loadMe;
loadMe=async function(...args){
  const result=await rtOriginalLoadMe(...args);
  if(currentEmployee?.role==='REQUESTOR') rtEnsureControl();
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

submitExpense=async function(){
  if(!payments.length) return;
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
    msg(`${r.refNo} ${revisionTarget?'revision submitted':'submitted'} successfully. Status: PENDING_REVIEW.`,'ok');
    cancelRevision();
    await loadMe();
  }catch(e){
    msg(e.message,'err');
    btn.textContent=revisionTarget
      ? 'Submit Revision'
      : rtIsReimbursement()?'Submit Reimbursement':'Submit Expense';
    btn.disabled=!payments.length;
  }
};

// The first loadMe() call starts at the end of the base app.js before this extension
// is evaluated, so run a lightweight follow-up sync once login state settles.
setTimeout(()=>rtEnsureControl(),350);
setTimeout(()=>rtEnsureControl(),1200);
