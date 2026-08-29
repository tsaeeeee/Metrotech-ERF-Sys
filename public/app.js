const $=s=>document.querySelector(s);
const rupiah=n=>'Rp'+Number(n||0).toLocaleString('id-ID');
let currentEmployee=null;
let payments=[];
let editingIndex=-1;
let revisionTarget=null;
let currentDetailId=null;

function msg(text,type='ok'){
  $('#msg').innerHTML=`<div class="notice ${type}">${esc(text)}</div>`;
  window.scrollTo({top:0,behavior:'smooth'});
}
function clearMsg(){ $('#msg').innerHTML=''; }
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function api(url,opt={}){
  const headers=opt.body instanceof FormData ? (opt.headers||{}) : {'Content-Type':'application/json',...(opt.headers||{})};
  const r=await fetch(url,{...opt,headers});
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.error||`HTTP ${r.status}`);
  return body;
}

async function loadSystemStatus(){
  try{
    const health=await api('/health');
    const official=String(health.pdfMode||'mock').toLowerCase()==='google-sheet';
    $('#engineBadge').textContent=official?'PDF: OFFICIAL TEMPLATE':'PDF: MOCK';
    $('#engineBadge').classList.toggle('official',official);
    $('#engineBadge').classList.toggle('mock',!official);
  }catch{
    $('#engineBadge').textContent='PDF: unavailable';
    $('#engineBadge').classList.add('mock');
  }
}

async function loadUsers(){
  try{
    const mode=await api('/api/auth-mode');
    if(mode.devAuth){
      $('#loginTitle').textContent='Development Login';
      $('#loginHint').textContent='Choose a dummy employee to preview each workflow layer.';
      const {users}=await api('/api/dev/users');
      $('#users').innerHTML=users.map(u=>`
        <button class="user-card" onclick="login('${esc(u.email)}')">
          <strong>${esc(u.name)}</strong>
          <span>${esc(u.role)}</span>
          <small>${esc(u.email)}</small>
        </button>`).join('');
    }else{
      $('#loginTitle').textContent='Google Workspace Sign In';
      $('#loginHint').textContent='Use your company Google Workspace account. Your role is loaded automatically from the employee master.';
      $('#users').innerHTML=mode.googleAuthReady
        ? '<button class="user-card google-login" onclick="location.href=\'/auth/google\'"><strong>Continue with Google</strong><span>COMPANY WORKSPACE</span><small>Secure organization sign in</small></button>'
        : '<div class="auth-warning">Google Workspace authentication is not configured yet.</div>';
    }
  }catch(e){msg(e.message,'err')}
}

async function login(email){
  try{
    await api('/api/dev/login',{method:'POST',body:JSON.stringify({email})});
    await loadMe();
  }catch(e){msg(e.message,'err')}
}

async function loadMe(){
  try{
    const {employee,requests}=await api('/api/me');
    currentEmployee=employee;
    $('#loginCard').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    $('#userBadge').textContent=`${employee.name} · ${employee.role}`;
    $('#roleTitle').textContent=employee.role==='REQUESTOR'?'Requestor Dashboard':employee.role==='REVIEWER'?'Reviewer Dashboard':'Approver Dashboard';
    $('#queueTitle').textContent=employee.role==='REQUESTOR'?'My Requests':employee.role==='REVIEWER'?'Pending Review':'Pending Approval';
    $('#queueHint').textContent=employee.role==='REQUESTOR'?'Track submitted requests and revise rejected items.':
      employee.role==='REVIEWER'?'Open a request to compare the form and evidence, then approve or reject.':
      'Open a reviewed request for final approval.';
    $('#identity').textContent=employee.email;
    $('#requestForm').classList.toggle('hidden',employee.role!=='REQUESTOR');
    const fields=[['Employee ID',employee.employee_id],['Department',employee.department],['Location',employee.location],['Division',employee.division],['Role',employee.role]];
    $('#profile').innerHTML=fields.map(([a,b])=>`<div><label>${a}</label><strong>${esc(b)}</strong></div>`).join('');
    renderRequests(requests);
    if(employee.role==='REQUESTOR' && !$('#paymentDate').value) $('#paymentDate').value=new Date().toISOString().slice(0,10);
  }catch(e){
    currentEmployee=null;
    $('#loginCard').classList.remove('hidden');
    $('#dashboard').classList.add('hidden');
    await loadUsers();
  }
}

function renderRequests(requests){
  if(!requests.length){
    $('#empty').classList.remove('hidden');
    $('#table').classList.add('hidden');
    return;
  }
  $('#empty').classList.add('hidden');
  $('#table').classList.remove('hidden');
  $('#tbody').innerHTML=requests.map(r=>{
    const revisable=['REVIEW_REJECTED','APPROVAL_REJECTED','RECALLED'].includes(r.status);
    const revise=currentEmployee?.role==='REQUESTOR' && revisable
      ? `<button class="btn tiny warning" onclick="startRevision('${r.id}')">${r.status==='RECALLED'?'Edit & Resubmit':'Revise'}</button>`
      : '';
    const recall=currentEmployee?.role==='REQUESTOR' && r.status==='PENDING_REVIEW'
      ? `<button class="btn tiny recall" onclick="recallRequest('${r.id}','${esc(r.ref_no)}')">Recall</button>`
      : '';
    return `<tr>
      <td><strong>${esc(r.ref_no)}</strong>${r.last_rejection_reason?`<div class="reason-mini">${esc(r.last_rejection_reason)}</div>`:''}</td>
      <td>${esc(r.employee_name)}</td>
      <td>${String(r.request_date).slice(0,10)}</td>
      <td class="money">${rupiah(r.total)}</td>
      <td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
      <td>${r.revision}</td>
      <td class="actions"><button class="btn tiny ghost" onclick="openRequest('${r.id}')">Open</button> ${recall} ${revise}</td>
    </tr>`;
  }).join('');
}

function selectedFiles(){ return Array.from($('#evidence').files||[]); }

function syncAddButton(){
  const valid=$('#category').value.trim() && $('#purpose').value.trim() && $('#paymentDate').value &&
    Number($('#amount').value)>0 && selectedFiles().length>0;
  $('#addPaymentBtn').disabled=!valid;
}

function syncEvidenceInfo(){
  const files=selectedFiles();
  $('#evidenceInfo').textContent=files.length
    ? `${files.length} file(s): ${files.map(f=>f.name).join(', ')}`
    : (editingIndex>=0?'Re-attach evidence to update this payment':'No evidence selected');
  syncAddButton();
}

document.addEventListener('input',e=>{
  if(['category','purpose','paymentDate','amount'].includes(e.target.id)) syncAddButton();
});
document.addEventListener('change',e=>{
  if(e.target.id==='evidence') syncEvidenceInfo();
});

function addPayment(){
  clearMsg();
  const files=selectedFiles();
  const x={
    category:$('#category').value.trim(),
    purpose:$('#purpose').value.trim(),
    paymentDate:$('#paymentDate').value,
    amount:Math.round(Number($('#amount').value)),
    evidence:files
  };
  if(!x.category||!x.purpose||!x.paymentDate||!x.amount||!files.length)
    return msg('Complete all payment fields and attach evidence first.','err');

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
}

function resetPaymentForm(){
  $('#category').value='';
  $('#purpose').value='';
  $('#amount').value='';
  $('#evidence').value='';
  $('#evidenceInfo').textContent='No evidence selected';
  if(!$('#paymentDate').value) $('#paymentDate').value=new Date().toISOString().slice(0,10);
  syncAddButton();
}

function editPayment(i){
  const x=payments[i];
  $('#category').value=x.category;
  $('#purpose').value=x.purpose;
  $('#paymentDate').value=x.paymentDate;
  $('#amount').value=x.amount;
  $('#evidence').value='';
  editingIndex=i;
  $('#evidenceInfo').textContent='Re-attach evidence to update this payment';
  $('#addPaymentBtn').textContent='Update Payment';
  syncAddButton();
  $('#requestForm').scrollIntoView({behavior:'smooth'});
}

function deletePayment(i){
  payments.splice(i,1);
  if(editingIndex===i){editingIndex=-1;resetPaymentForm();$('#addPaymentBtn').textContent='+ Add Payment';}
  else if(editingIndex>i) editingIndex--;
  renderPayments();
}

function renderPayments(){
  const body=$('#paymentBody');
  if(!payments.length) body.innerHTML='<tr><td colspan="7" class="empty">No payments added yet.</td></tr>';
  else body.innerHTML=payments.map((x,i)=>`<tr>
    <td>${i+1}</td>
    <td>${esc(x.category)}</td>
    <td>${esc(x.purpose)}</td>
    <td>${esc(x.paymentDate)}</td>
    <td>${x.evidence.map(f=>`<span class="file-chip">📎 ${esc(f.name)}</span>`).join(' ')}</td>
    <td class="money">${rupiah(x.amount)}</td>
    <td class="actions"><button class="btn tiny ghost" onclick="editPayment(${i})">Edit</button> <button class="btn tiny danger" onclick="deletePayment(${i})">Delete</button></td>
  </tr>`).join('');
  $('#grandTotal').textContent=rupiah(payments.reduce((s,x)=>s+x.amount,0));
  $('#submitExpenseBtn').disabled=!payments.length;
}

async function startRevision(id){
  try{
    const data=await api(`/api/requests/${id}`);
    const refNo=data.request.ref_no;
    const recalled=data.request.status==='RECALLED';
    const reason=data.request.last_rejection_reason||'Please revise this request.';
    revisionTarget={id,refNo};
    payments=[]; editingIndex=-1; renderPayments(); resetPaymentForm();
    $('#requestFormTitle').textContent=`${recalled?'Edit & Resubmit':'Revise'} ${refNo}`;
    $('#revisionBanner').classList.remove('hidden');
    $('#revisionBanner').innerHTML=recalled
      ? `<strong>Recalled:</strong> This request has been pulled back from Reviewer. Re-enter the payment data and attach evidence, then submit it again.`
      : `<strong>Rejected:</strong> ${esc(reason)}. Re-enter the payment data and attach evidence for the new revision.`;
    $('#cancelRevisionBtn').classList.remove('hidden');
    $('#submitExpenseBtn').textContent='Submit Revision';
    $('#requestForm').scrollIntoView({behavior:'smooth'});
  }catch(e){msg(e.message,'err')}
}

async function recallRequest(id,refNo){
  if(!confirm(`Recall ${refNo}? It will be removed from the Reviewer queue until you resubmit it.`)) return;
  try{
    const r=await api(`/api/requests/${id}/recall`,{method:'POST',body:'{}'});
    msg(`${r.refNo} recalled successfully. Reviewer can no longer action it until you resubmit.`,'ok');
    await loadMe();
  }catch(e){msg(e.message,'err')}
}

function cancelRevision(){
  revisionTarget=null; payments=[]; editingIndex=-1; renderPayments(); resetPaymentForm();
  $('#requestFormTitle').textContent='Create Expense Request';
  $('#revisionBanner').classList.add('hidden');
  $('#cancelRevisionBtn').classList.add('hidden');
  $('#submitExpenseBtn').textContent='Submit Expense';
}

async function submitExpense(){
  if(!payments.length) return;
  clearMsg();
  const btn=$('#submitExpenseBtn');
  btn.disabled=true; btn.textContent=revisionTarget?'Submitting Revision…':'Submitting…';
  try{
    const fd=new FormData();
    fd.append('items',JSON.stringify(payments.map(x=>({
      category:x.category,purpose:x.purpose,paymentDate:x.paymentDate,amount:x.amount
    }))));
    payments.forEach((x,i)=>x.evidence.forEach(file=>fd.append(`evidence_${i}`,file,file.name)));
    const url=revisionTarget?`/api/requests/${revisionTarget.id}/revise`:'/api/requests';
    const r=await api(url,{method:'POST',body:fd});
    msg(`${r.refNo} ${revisionTarget?'revision submitted':'submitted'} successfully. Status: PENDING_REVIEW.`,'ok');
    cancelRevision();
    await loadMe();
  }catch(e){
    msg(e.message,'err');
    btn.textContent=revisionTarget?'Submit Revision':'Submit Expense';
    btn.disabled=!payments.length;
  }
}

async function openRequest(id){
  clearMsg();
  try{
    const data=await api(`/api/requests/${id}`);
    currentDetailId=id;
    const r=data.request;
    $('#detailRef').textContent=r.ref_no;
    $('#detailMeta').textContent=`${r.employee_name} · Revision ${r.revision} · ${r.status}`;
    $('#detailSummary').innerHTML=[
      ['Request Date',String(r.request_date).slice(0,10)],
      ['Employee ID',r.employee_id],
      ['Department',r.department],
      ['Location',r.location],
      ['Division',r.division],
      ['Total',rupiah(r.total)]
    ].map(([a,b])=>`<div><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join('');

    $('#detailItems').innerHTML=data.items.map(it=>`<tr>
      <td>${it.line_no}</td><td>${esc(it.category)}</td><td>${esc(it.purpose)}</td>
      <td>${String(it.payment_date).slice(0,10)}</td>
      <td>${(it.evidence_names||[]).map(n=>`<span class="file-chip">📎 ${esc(n)}</span>`).join(' ')}</td>
      <td class="money">${rupiah(it.amount)}</td>
    </tr>`).join('');

    $('#auditTrail').innerHTML=data.actions.length?data.actions.map(a=>`
      <div class="audit-row">
        <div class="audit-dot"></div>
        <div><strong>${esc(a.action.replaceAll('_',' '))}</strong><span>${esc(a.actor_name)} · ${esc(a.actor_role)}</span>
        ${a.reason?`<p>${esc(a.reason)}</p>`:''}<small>${new Date(a.created_at).toLocaleString('id-ID')}</small></div>
      </div>`).join(''):'<div class="muted">No audit entries.</div>';

    $('#formPdf').src=data.documents.form?`/api/requests/${id}/form?t=${Date.now()}`:'about:blank';
    $('#evidencePdf').src=data.documents.evidence?`/api/requests/${id}/evidence?t=${Date.now()}`:'about:blank';

    const actionable=(currentEmployee.role==='REVIEWER'&&r.status==='PENDING_REVIEW') ||
      (currentEmployee.role==='APPROVER'&&r.status==='PENDING_APPROVAL');
    $('#decisionPanel').classList.toggle('hidden',!actionable);
    $('#decisionReason').value='';
    $('#rejectBtn').disabled=true;
    $('#detailModal').classList.remove('hidden');
    document.body.classList.add('modal-open');
  }catch(e){msg(e.message,'err')}
}

function closeDetail(){
  $('#detailModal').classList.add('hidden');
  $('#formPdf').src='about:blank';
  $('#evidencePdf').src='about:blank';
  currentDetailId=null;
  document.body.classList.remove('modal-open');
}

function modalBackdrop(e){ if(e.target.id==='detailModal') closeDetail(); }
function syncRejectButton(){ $('#rejectBtn').disabled=!$('#decisionReason').value.trim(); }

async function sendDecision(decision){
  if(!currentDetailId) return;
  const reason=$('#decisionReason').value.trim();
  if(decision==='REJECT'&&!reason) return;
  const isReviewer=currentEmployee.role==='REVIEWER';
  const url=isReviewer?`/api/requests/${currentDetailId}/review`:`/api/requests/${currentDetailId}/approve`;
  $('#approveBtn').disabled=true; $('#rejectBtn').disabled=true;
  try{
    const r=await api(url,{method:'POST',body:JSON.stringify({decision,reason})});
    closeDetail();
    msg(`Request updated to ${r.status}.`,'ok');
    await loadMe();
  }catch(e){
    msg(e.message,'err');
    $('#approveBtn').disabled=false;
    syncRejectButton();
  }
}

async function logout(){
  await api('/api/logout',{method:'POST',body:'{}'});
  currentEmployee=null; payments=[]; editingIndex=-1; revisionTarget=null; currentDetailId=null;
  renderPayments();
  $('#dashboard').classList.add('hidden');
  $('#loginCard').classList.remove('hidden');
  $('#userBadge').textContent='Not signed in';
  await loadUsers();
}

loadSystemStatus();
loadMe();