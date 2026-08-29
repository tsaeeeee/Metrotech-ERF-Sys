const $=s=>document.querySelector(s);
const rupiah=n=>'Rp'+Number(n||0).toLocaleString('id-ID');
let currentEmployee=null;
let payments=[];
let editingIndex=-1;

function msg(text,type='ok'){ $('#msg').innerHTML=`<div class="notice ${type}">${esc(text)}</div>`; window.scrollTo({top:0,behavior:'smooth'}); }
function clearMsg(){ $('#msg').innerHTML=''; }
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function api(url,opt={}){
  const headers=opt.body instanceof FormData ? (opt.headers||{}) : {'Content-Type':'application/json',...(opt.headers||{})};
  const r=await fetch(url,{...opt,headers});
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.error||`HTTP ${r.status}`);
  return body;
}

async function loadUsers(){
  try{
    const {users}=await api('/api/dev/users');
    $('#users').innerHTML=users.map(u=>`
      <button class="user-card" onclick="login('${esc(u.email)}')">
        <strong>${esc(u.name)}</strong>
        <span>${esc(u.role)}</span>
        <small>${esc(u.email)}</small>
      </button>`).join('');
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
  if(requests.length){
    $('#empty').classList.add('hidden'); $('#table').classList.remove('hidden');
    $('#tbody').innerHTML=requests.map(r=>`<tr><td><strong>${esc(r.ref_no)}</strong></td><td>${esc(r.employee_name)}</td><td>${String(r.request_date).slice(0,10)}</td><td>${rupiah(r.total)}</td><td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td><td>${r.revision}</td></tr>`).join('');
  }else{
    $('#empty').classList.remove('hidden'); $('#table').classList.add('hidden');
  }
}

function selectedFiles(){ return Array.from($('#evidence').files||[]); }

function syncAddButton(){
  const valid=$('#category').value.trim() && $('#purpose').value.trim() && $('#paymentDate').value && Number($('#amount').value)>0 && selectedFiles().length>0;
  $('#addPaymentBtn').disabled=!valid;
}

function syncEvidenceInfo(){
  const files=selectedFiles();
  $('#evidenceInfo').textContent=files.length ? `${files.length} file(s): ${files.map(f=>f.name).join(', ')}` : 'No evidence selected';
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
  if(!x.category||!x.purpose||!x.paymentDate||!x.amount||!files.length) return msg('Complete all payment fields and attach evidence first.','err');
  if(editingIndex>=0){
    payments.splice(editingIndex,0,x);
    editingIndex=-1;
    $('#addPaymentBtn').textContent='+ Add Payment';
  } else {
    payments.push(x);
  }
  resetPaymentForm();
  renderPayments();
}

function resetPaymentForm(){
  $('#category').value=''; $('#purpose').value=''; $('#amount').value=''; $('#evidence').value='';
  $('#evidenceInfo').textContent='No evidence selected';
  if(!$('#paymentDate').value) $('#paymentDate').value=new Date().toISOString().slice(0,10);
  syncAddButton();
}

function editPayment(i){
  const x=payments[i];
  payments.splice(i,1);
  $('#category').value=x.category;
  $('#purpose').value=x.purpose;
  $('#paymentDate').value=x.paymentDate;
  $('#amount').value=x.amount;
  editingIndex=i;
  $('#evidenceInfo').textContent='Re-attach evidence to update this payment';
  $('#addPaymentBtn').textContent='Update Payment';
  renderPayments();
  syncAddButton();
  $('#requestForm').scrollIntoView({behavior:'smooth'});
}

function deletePayment(i){
  payments.splice(i,1);
  if(editingIndex===i) editingIndex=-1;
  renderPayments();
}

function renderPayments(){
  const body=$('#paymentBody');
  if(!payments.length) body.innerHTML='<tr><td colspan="7" class="empty">No payments added yet.</td></tr>';
  else body.innerHTML=payments.map((x,i)=>`<tr>
    <td>${i+1}</td><td>${esc(x.category)}</td><td>${esc(x.purpose)}</td><td>${esc(x.paymentDate)}</td>
    <td>${x.evidence.map(f=>`<span class="file-chip">📎 ${esc(f.name)}</span>`).join(' ')}</td>
    <td class="money">${rupiah(x.amount)}</td>
    <td class="actions"><button class="btn tiny ghost" onclick="editPayment(${i})">Edit</button> <button class="btn tiny danger" onclick="deletePayment(${i})">Delete</button></td>
  </tr>`).join('');
  $('#grandTotal').textContent=rupiah(payments.reduce((s,x)=>s+x.amount,0));
  $('#submitExpenseBtn').disabled=!payments.length;
}

async function submitExpense(){
  if(!payments.length) return;
  clearMsg();
  const btn=$('#submitExpenseBtn');
  btn.disabled=true; btn.textContent='Submitting…';
  try{
    const fd=new FormData();
    fd.append('items',JSON.stringify(payments.map(x=>({category:x.category,purpose:x.purpose,paymentDate:x.paymentDate,amount:x.amount}))));
    payments.forEach((x,i)=>x.evidence.forEach(file=>fd.append(`evidence_${i}`,file,file.name)));
    const r=await api('/api/requests',{method:'POST',body:fd});
    msg(`${r.refNo} submitted successfully and is now Pending Review.`,'ok');
    payments=[]; editingIndex=-1; renderPayments(); resetPaymentForm();
    await loadMe();
  }catch(e){msg(e.message,'err')}
  finally{btn.textContent='Submit Expense'; btn.disabled=!payments.length;}
}

async function logout(){
  await api('/api/logout',{method:'POST',body:'{}'});
  currentEmployee=null; payments=[]; editingIndex=-1; renderPayments();
  $('#dashboard').classList.add('hidden'); $('#loginCard').classList.remove('hidden'); $('#userBadge').textContent='Not signed in';
  await loadUsers();
}
loadMe();