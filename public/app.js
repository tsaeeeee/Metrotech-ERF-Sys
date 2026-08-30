const $=s=>document.querySelector(s);
const rupiah=n=>'Rp'+Number(n||0).toLocaleString('id-ID');
let currentEmployee=null;
let payments=[];
let editingIndex=-1;
let revisionTarget=null;
let currentDetailId=null;
let adminUsers=[];
let editingAdminEmail=null;

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

async function submitLogin(event){
  event.preventDefault();
  clearMsg();
  const username=$('#loginUsername').value.trim();
  const password=$('#loginPassword').value;
  const btn=$('#loginBtn');
  btn.disabled=true;
  btn.textContent='Signing In…';
  try{
    await api('/api/login',{method:'POST',body:JSON.stringify({username,password})});
    $('#loginPassword').value='';
    await loadMe();
  }catch(e){
    msg(e.message,'err');
    $('#loginPassword').value='';
    $('#loginPassword').focus();
  }finally{
    btn.disabled=false;
    btn.textContent='Sign In';
  }
}

async function loadMe(){
  try{
    const {employee,requests}=await api('/api/me');
    currentEmployee=employee;
    $('#loginCard').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');

    const initials=String(employee.name||employee.email||'U')
      .split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
    $('#userAvatar').textContent=initials||'U';
    $('#userMenuName').textContent=employee.name||employee.email;
    $('#userMenuRole').textContent=employee.role;
    $('#userMenuFullName').textContent=employee.name||employee.email;
    $('#userMenuEmail').textContent=employee.email;
    $('#userMenuWrap').classList.remove('hidden');

    const isAdmin=employee.role==='ADMIN';
    $('#workflowDashboard').classList.toggle('hidden',isAdmin);
    $('#adminDashboard').classList.toggle('hidden',!isAdmin);
    $('#userProfileMenuItem').classList.toggle('hidden',isAdmin);

    if(isAdmin){
      await loadAdminUsers();
      return;
    }

    $('#roleTitle').textContent=employee.role==='REQUESTOR'?'Requestor Dashboard':employee.role==='REVIEWER'?'Reviewer Dashboard':'Approver Dashboard';
    $('#queueTitle').textContent=employee.role==='REQUESTOR'?'My Requests':employee.role==='REVIEWER'?'Pending Review':'Pending Approval';
    $('#requestForm').classList.toggle('hidden',employee.role!=='REQUESTOR');

    const fields=[
      ['Employee ID',employee.employee_id],
      ['Department',employee.department],
      ['Location',employee.location],
      ['Division',employee.division]
    ];
    $('#profile').innerHTML=fields.map(([a,b])=>`<div><label>${a}</label><strong>${esc(b)}</strong></div>`).join('');
    renderRequests(requests);
    if(employee.role==='REQUESTOR' && !$('#paymentDate').value) $('#paymentDate').value=new Date().toISOString().slice(0,10);
  }catch(e){
    currentEmployee=null;
    clearMsg();
    $('#loginCard').classList.remove('hidden');
    $('#dashboard').classList.add('hidden');
    $('#userMenuWrap').classList.add('hidden');
    closeUserMenu();
    setTimeout(()=>$('#loginUsername')?.focus(),0);
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
    const savePdf=r.status==='APPROVED'
      ? `<button class="btn tiny primary" onclick="downloadFinalPdf('${r.id}')">Save PDF</button>`
      : '';
    return `<tr>
      <td><strong>${esc(r.ref_no)}</strong>${r.last_rejection_reason?`<div class="reason-mini">${esc(r.last_rejection_reason)}</div>`:''}</td>
      <td>${esc(r.employee_name)}</td>
      <td>${String(r.request_date).slice(0,10)}</td>
      <td class="money">${rupiah(r.total)}</td>
      <td class="status-col"><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
      <td class="rev-col">${r.revision}</td>
      <td class="actions action-col"><button class="btn tiny ghost" onclick="openRequest('${r.id}')">Open</button> ${savePdf} ${recall} ${revise}</td>
    </tr>`;
  }).join('');
}

function toggleUserMenu(event){
  event?.stopPropagation();
  $('#userMenu').classList.toggle('hidden');
}

function closeUserMenu(){
  $('#userMenu')?.classList.add('hidden');
}

document.addEventListener('click',e=>{
  const wrap=$('#userMenuWrap');
  if(wrap && !wrap.contains(e.target)) closeUserMenu();
});

function openProfileModal(){
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  const fields=[
    ['Name',currentEmployee.name],
    ['Email',currentEmployee.email],
    ['Employee ID',currentEmployee.employee_id],
    ['Department',currentEmployee.department],
    ['Location',currentEmployee.location],
    ['Division',currentEmployee.division],
    ['Role',currentEmployee.role]
  ];
  $('#lockedProfileGrid').innerHTML=fields.map(([label,value])=>`
    <div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
  `).join('');
  $('#profileSignature').value='';
  $('#profileSignatureInfo').textContent='No file selected';
  $('#profileModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeProfileModal(){
  $('#profileModal').classList.add('hidden');
  $('#profileSignature').value='';
  $('#profileSignatureInfo').textContent='No file selected';
  if($('#detailModal').classList.contains('hidden') && $('#adminUserModal').classList.contains('hidden'))
    document.body.classList.remove('modal-open');
}

function profileBackdrop(e){
  if(e.target.id==='profileModal') closeProfileModal();
}

async function saveProfile(event){
  event.preventDefault();
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  const sig=$('#profileSignature').files?.[0];
  if(!sig) return msg('Choose a signature image first.','err');

  const btn=$('#saveProfileBtn');
  btn.disabled=true;
  btn.textContent='Saving…';
  try{
    const fd=new FormData();
    fd.append('signature',sig,sig.name);
    await api('/api/profile',{method:'PUT',body:fd});
    closeProfileModal();
    msg('Signature updated successfully.','ok');
    await loadMe();
  }catch(e){
    msg(e.message,'err');
  }finally{
    btn.disabled=false;
    btn.textContent='Save Signature';
  }
}

async function loadAdminUsers(){
  if(currentEmployee?.role!=='ADMIN') return;
  try{
    const data=await api('/api/admin/users');
    adminUsers=data.users||[];
    renderAdminUsers();
  }catch(e){msg(e.message,'err')}
}

function renderAdminUsers(){
  const empty=$('#adminUsersEmpty');
  const table=$('#adminUsersTable');
  if(!adminUsers.length){
    empty.classList.remove('hidden');
    table.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  table.classList.remove('hidden');
  $('#adminUsersBody').innerHTML=adminUsers.map(u=>`
    <tr>
      <td><strong>${esc(u.name)}</strong><div class="admin-username">@${esc(u.username||'—')}</div></td>
      <td>${esc(u.email)}</td>
      <td>${esc(u.employee_id)}</td>
      <td>${esc(u.department)}</td>
      <td><span class="role-chip">${esc(u.role)}</span></td>
      <td>${u.has_signature?'<span class="signature-state ready">Uploaded</span>':'<span class="signature-state">Not uploaded</span>'}</td>
      <td>${u.active?'<span class="user-state active">Active</span>':'<span class="user-state">Inactive</span>'}</td>
      <td class="actions action-col"><button class="btn tiny ghost" type="button" onclick="openAdminUserModal('${encodeURIComponent(u.email)}')">Edit</button></td>
    </tr>
  `).join('');
}

function toggleAdminRoleMenu(event){
  event?.stopPropagation();
  const menu=$('#adminRoleMenu');
  const trigger=$('#adminRoleButton');
  const willOpen=menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  $('#adminRoleSelect').classList.toggle('open',willOpen);
  trigger.setAttribute('aria-expanded',willOpen?'true':'false');
}

function closeAdminRoleMenu(){
  $('#adminRoleMenu')?.classList.add('hidden');
  $('#adminRoleSelect')?.classList.remove('open');
  $('#adminRoleButton')?.setAttribute('aria-expanded','false');
}

function selectAdminRole(value,label){
  $('#adminRole').value=value;
  $('#adminRoleLabel').textContent=label;
  document.querySelectorAll('#adminRoleMenu button').forEach(btn=>{
    btn.classList.toggle('selected',btn.dataset.value===value);
  });
  closeAdminRoleMenu();
}

document.addEventListener('click',e=>{
  const custom=$('#adminRoleSelect');
  if(custom && !custom.contains(e.target)) closeAdminRoleMenu();
});

function openAdminUserModal(encodedEmail=''){
  if(currentEmployee?.role!=='ADMIN') return;
  editingAdminEmail=encodedEmail?decodeURIComponent(encodedEmail):null;
  const user=editingAdminEmail?adminUsers.find(u=>u.email===editingAdminEmail):null;

  $('#adminUserModalTitle').textContent=user?'Edit User':'Create User';
  $('#adminUserModalHint').textContent=user?'Update user master data. Email is locked after creation.':'Create a new Expense Request System account.';
  $('#saveAdminUserBtn').textContent=user?'Save Changes':'Create User';

  $('#adminName').value=user?.name||'';
  $('#adminEmail').value=user?.email||'';
  $('#adminEmail').disabled=!!user;
  $('#adminUsername').value=user?.username||'';
  $('#adminPassword').value='';
  $('#adminPassword').required=!user;
  $('#adminPasswordLabel').textContent=user?'Reset Password':'Temporary Password';
  $('#adminPasswordHint').textContent=user?'Leave empty to keep the current password.':'Required when creating a user.';
  $('#adminEmployeeId').value=user?.employee_id||'';
  $('#adminDepartment').value=user?.department||'';
  $('#adminLocation').value=user?.location||'';
  $('#adminDivision').value=user?.division||'';
  const roleValue=user?.role||'REQUESTOR';
  const roleLabel=roleValue==='REVIEWER'?'Reviewer':roleValue==='APPROVER'?'Approver':'Requestor';
  selectAdminRole(roleValue,roleLabel);
  $('#adminActive').checked=user?.active!==false;
  $('#adminActiveField').classList.toggle('hidden',!user);

  $('#adminUserModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeAdminUserModal(){
  $('#adminUserModal').classList.add('hidden');
  closeAdminRoleMenu();
  editingAdminEmail=null;
  $('#adminUserForm').reset();
  $('#adminEmail').disabled=false;
  if($('#profileModal').classList.contains('hidden') && $('#detailModal').classList.contains('hidden'))
    document.body.classList.remove('modal-open');
}

function adminUserBackdrop(e){
  if(e.target.id==='adminUserModal') closeAdminUserModal();
}

async function saveAdminUser(event){
  event.preventDefault();
  if(currentEmployee?.role!=='ADMIN') return;

  const body={
    name:$('#adminName').value.trim(),
    email:$('#adminEmail').value.trim(),
    username:$('#adminUsername').value.trim(),
    password:$('#adminPassword').value,
    employeeId:$('#adminEmployeeId').value.trim(),
    department:$('#adminDepartment').value.trim(),
    location:$('#adminLocation').value.trim(),
    division:$('#adminDivision').value.trim(),
    role:$('#adminRole').value,
    active:editingAdminEmail?$('#adminActive').checked:true
  };

  const btn=$('#saveAdminUserBtn');
  btn.disabled=true;
  btn.textContent=editingAdminEmail?'Saving…':'Creating…';
  try{
    if(editingAdminEmail){
      await api(`/api/admin/users/${encodeURIComponent(editingAdminEmail)}`,{
        method:'PUT',body:JSON.stringify(body)
      });
      msg('User updated successfully.','ok');
    }else{
      await api('/api/admin/users',{method:'POST',body:JSON.stringify(body)});
      msg('User created successfully.','ok');
    }
    closeAdminUserModal();
    await loadAdminUsers();
  }catch(e){
    msg(e.message,'err');
  }finally{
    btn.disabled=false;
    btn.textContent=editingAdminEmail?'Save Changes':'Create User';
  }
}

function downloadFinalPdf(id){
  if(!id) return;
  window.location.href=`/api/requests/${id}/form/download`;
}

function toggleCategoryMenu(event){
  event?.stopPropagation();
  const menu=$('#categoryMenu');
  const trigger=$('#categoryButton');
  const willOpen=menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  $('#categorySelect').classList.toggle('open',willOpen);
  trigger.setAttribute('aria-expanded',willOpen?'true':'false');
}

function closeCategoryMenu(){
  $('#categoryMenu')?.classList.add('hidden');
  $('#categorySelect')?.classList.remove('open');
  $('#categoryButton')?.setAttribute('aria-expanded','false');
}

function selectCategory(value){
  $('#category').value=value;
  $('#categoryLabel').textContent=value;
  $('#categoryLabel').classList.remove('custom-select-placeholder');
  document.querySelectorAll('#categoryMenu button').forEach(btn=>{
    btn.classList.toggle('selected',btn.dataset.value===value);
  });
  closeCategoryMenu();
  syncAddButton();
}

function resetCategory(){
  $('#category').value='';
  $('#categoryLabel').textContent='Select category';
  $('#categoryLabel').classList.add('custom-select-placeholder');
  document.querySelectorAll('#categoryMenu button').forEach(btn=>btn.classList.remove('selected'));
  closeCategoryMenu();
}

document.addEventListener('click',e=>{
  const custom=$('#categorySelect');
  if(custom && !custom.contains(e.target)) closeCategoryMenu();
});

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
    : (editingIndex>=0?'Re-attach evidence to update this payment':'No file selected');
  syncAddButton();
}

document.addEventListener('input',e=>{
  if(['category','purpose','paymentDate','amount'].includes(e.target.id)) syncAddButton();
});
document.addEventListener('change',e=>{
  if(e.target.id==='evidence') syncEvidenceInfo();
  if(e.target.id==='profileSignature'){
    const file=e.target.files?.[0];
    $('#profileSignatureInfo').textContent=file?file.name:'No file selected';
  }
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
  resetCategory();
  $('#purpose').value='';
  $('#amount').value='';
  $('#evidence').value='';
  $('#evidenceInfo').textContent='No file selected';
  if(!$('#paymentDate').value) $('#paymentDate').value=new Date().toISOString().slice(0,10);
  syncAddButton();
}

function editPayment(i){
  const x=payments[i];
  selectCategory(x.category);
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

let pdfJsModulePromise=null;

async function getPdfJs(){
  if(!pdfJsModulePromise){
    pdfJsModulePromise=import('/vendor/pdfjs/pdf.mjs').then(pdfjs=>{
      pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.mjs';
      return pdfjs;
    });
  }
  return pdfJsModulePromise;
}

async function renderPdfDocument(url,targetSelector){
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
    target.innerHTML='';

    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
      const page=await pdf.getPage(pageNumber);
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
    }
  }catch(e){
    console.error('PDF preview failed:',e);
    target.innerHTML='<div class="pdf-empty">Unable to preview this document.</div>';
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

    const stamp=Date.now();
    const formUrl=data.documents.form?`/api/requests/${id}/form?t=${stamp}`:null;
    const evidenceUrl=data.documents.evidence?`/api/requests/${id}/evidence?t=${stamp}`:null;

    const actionable=(currentEmployee.role==='REVIEWER'&&r.status==='PENDING_REVIEW') ||
      (currentEmployee.role==='APPROVER'&&r.status==='PENDING_APPROVAL');
    $('#decisionPanel').classList.toggle('hidden',!actionable);
    $('#detailSavePdfBtn').classList.toggle('hidden',r.status!=='APPROVED');
    $('#decisionReason').value='';
    $('#approveBtn').disabled=!actionable;
    $('#rejectBtn').disabled=true;
    $('#detailModal').classList.remove('hidden');
    document.body.classList.add('modal-open');
    renderPdfDocument(formUrl,'#formPdfViewer');
    renderPdfDocument(evidenceUrl,'#evidencePdfViewer');
  }catch(e){msg(e.message,'err')}
}

function closeDetail(){
  $('#detailModal').classList.add('hidden');
  $('#formPdfViewer').innerHTML='';
  $('#evidencePdfViewer').innerHTML='';
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
  clearMsg();
  currentEmployee=null; payments=[]; editingIndex=-1; revisionTarget=null; currentDetailId=null;
  adminUsers=[]; editingAdminEmail=null;
  $('#profileModal').classList.add('hidden');
  renderPayments();
  $('#dashboard').classList.add('hidden');
  $('#loginCard').classList.remove('hidden');
  $('#userMenuWrap').classList.add('hidden');
  closeUserMenu();
  $('#loginPassword').value='';
  setTimeout(()=>$('#loginUsername')?.focus(),0);
}

loadMe();