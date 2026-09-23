// EMS navigation and ECF interaction extend the existing ERF form and detail UI.
let emsView='home';
let emsDetail=null;

function emsNavigate(view){
  if(!currentEmployee) return;
  const admin=currentEmployee.role==='ADMIN';
  if(admin && !['home','admin-users','admin-app'].includes(view)) view='admin-users';
  if(!admin && view.startsWith('admin-')) view='home';
  if(!admin && view==='ecf' && currentEmployee.ecfRole==='NONE') view='erf';
  emsView=view;
  document.querySelectorAll('#emsNav [data-ems-view]').forEach(button=>
    button.classList.toggle('active',button.dataset.emsView===view));
  if(view.startsWith('admin-')) showAdminSection(view==='admin-app'?'app':'users');
  $('#emsHome').classList.toggle('hidden',view!=='home');
  $('#emsTasks').classList.toggle('hidden',view!=='tasks');
  $('#workflowDashboard').classList.toggle('hidden',!['erf','ecf','requests'].includes(view));
  $('#adminDashboard').classList.toggle('hidden',!view.startsWith('admin-'));
  $('#requestQueueCard').classList.toggle('hidden',view==='ecf'&&currentEmployee.ecfRole!=='REQUESTOR');
  const canCreate=currentEmployee.role==='REQUESTOR' &&
    (view==='erf'||(view==='ecf'&&currentEmployee.ecfRole==='REQUESTOR'));
  $('#requestForm').classList.toggle('hidden',!canCreate);
  $('#emsClaimFields').classList.toggle('hidden',view!=='ecf');
  $('#profile').parentElement.classList.toggle('hidden',view==='requests'||view==='ecf');
  if(view==='erf'||view==='ecf'||view==='requests'){
    $('#queueTitle').textContent=view==='requests'?'My Requests':view==='erf'?'Expense Requests':'Expense Claims';
    const data=window.emsBootstrap||{};
    const rows=view==='requests'?data.myRequests||[]:
      (data.requests||[]).filter(row=>row.form_type===(view==='ecf'?'ECF':'ERF'));
    renderRequests(rows);
  }
  if(view==='ecf'){
    rtRequestType='REIMBURSEMENT';
    rtApplyUi();
    $('#requestFormTitle').textContent=revisionTarget?'Revise Expense Claim':'Create Expense Claim';
    $('#submitExpenseBtn').textContent=revisionTarget?'Submit Revision':'Submit Claim';
  }else if(view==='erf' && !revisionTarget){
    rtRequestType='EXPENSE';rtApplyUi();
  }
  $('#evidenceModeNote')?.classList.toggle('hidden',view==='ecf');
  if(view==='tasks') emsRenderTasks();
  if(view==='home') emsLoadDashboard();
}

function emsRenderTasks(){
  const rows=window.emsBootstrap?.tasks||[];
  $('#emsTaskCount').textContent=rows.length?String(rows.length):'';
  $('#emsTaskRows').innerHTML=rows.length?rows.map(row=>`
    <div class="ems-task">
      <div><strong>${esc(row.ref_no)}</strong> <span class="status ${esc(row.status)}">${esc(row.status)}</span>
      <small>${esc(row.employee_name)} · ${row.form_type==='ECF'?'Claim':'Request'}</small></div>
      <strong>${rupiah(row.total)}</strong>
      <button class="btn tiny primary" onclick="openRequest('${row.id}')">Review</button>
    </div>`).join(''):'<div class="empty">No pending tasks.</div>';
}

async function emsLoadDashboard(){
  if(!currentEmployee || employeeNeedsSetup()) return;
  try{
    const data=await api('/api/ems/dashboard');
    const amount=(type,states)=>data.totals.filter(row=>row.form_type===type&&states.includes(row.status))
      .reduce((sum,row)=>sum+Number(row.amount),0);
    const requested=amount('ERF',['APPROVED']);
    const claimed=amount('ECF',['APPROVED']);
    const inProgress=amount('ECF',['PENDING_CHECK','PENDING_REVIEW','PENDING_APPROVAL']);
    const metrics=[['Approved ERF',requested],['Approved ECF',claimed],['ECF in progress',inProgress]];
    $('#emsMetrics').innerHTML=metrics.map(([label,value])=>
      `<div><small>${esc(label)}</small><strong>${rupiah(value)}</strong></div>`).join('');
    const months=[...new Set(data.trend.map(row=>row.month))];
    const max=Math.max(1,...data.trend.map(row=>Number(row.amount)));
    $('#emsTrend').innerHTML=months.length?months.map(month=>{
      const bars=['ERF','ECF'].map(type=>{
        const value=Number(data.trend.find(row=>row.month===month&&row.form_type===type)?.amount||0);
        return `<div class="ems-bar-line"><span>${type}</span><div class="ems-track"><i class="${type.toLowerCase()}" style="width:${Math.round(value/max*100)}%"></i></div><strong>${rupiah(value)}</strong></div>`;
      }).join('');
      return `<div class="ems-month"><b>${esc(month)}</b>${bars}</div>`;
    }).join(''):'<div class="empty">No approved transactions in the last six months.</div>';
    $('#emsCategories').innerHTML=data.categories.length?data.categories.map(row=>
      `<div class="ems-category"><span>${esc(row.category)} <small>${esc(row.form_type)}</small></span><strong>${rupiah(row.amount)}</strong></div>`
    ).join(''):'<div class="empty">No approved categories this month.</div>';
  }catch(e){msg(e.message,'err')}
}

const emsOriginalLoadMe=loadMe;
loadMe=async function(...args){
  await emsOriginalLoadMe(...args);
  if(!currentEmployee||employeeNeedsSetup()) return;
  const admin=currentEmployee.role==='ADMIN';
  $('#emsTransactionsNav').classList.toggle('hidden',admin);
  $('#emsActivityNav').classList.toggle('hidden',admin);
  $('#emsAdminNav').classList.toggle('hidden',!admin);
  $('#emsNav [data-ems-view="ecf"]').classList.toggle('hidden',currentEmployee.ecfRole==='NONE');
  emsNavigate(emsView);
};

const emsOriginalStartRevision=startRevision;
startRevision=async function(id){
  const data=await api(`/api/requests/${id}`).catch(e=>{msg(e.message,'err');return null});
  if(!data) return;
  emsNavigate(data.request.form_type==='ECF'?'ecf':'erf');
  await emsOriginalStartRevision(id);
  if(data.request.form_type==='ECF' && revisionTarget){
    rtRequestType='REIMBURSEMENT';rtApplyUi();
    $('#requestFormTitle').textContent=`Revise ${data.request.ref_no}`;
    $('#emsServiceOrder').value=data.request.service_order_number||'';
  }
};

const emsOriginalCancelRevision=cancelRevision;
cancelRevision=function(){
  emsOriginalCancelRevision();
  $('#emsServiceOrder').value='';
  emsNavigate(emsView);
};

const emsOriginalSubmitExpense=submitExpense;
submitExpense=async function(){
  if(emsView!=='ecf') return emsOriginalSubmitExpense();
  if(!payments.length||!sigRequireWorkflowSignature('submit this claim')) return;
  if(payments.some(item=>!(item.evidence||[]).length))
    return msg('Attach evidence for every payment.','err');
  const fd=new FormData();
  fd.append('serviceOrderNumber',$('#emsServiceOrder').value);
  fd.append('items',JSON.stringify(payments.map(item=>({
    category:item.category,purpose:item.purpose,paymentDate:item.paymentDate,
    amount:item.amount,...(item.sourceLineNo?{sourceLineNo:item.sourceLineNo}:{})
  }))));
  payments.forEach((item,index)=>(item.evidence||[]).filter(file=>file instanceof File)
    .forEach(file=>fd.append(`evidence_${index}`,file,file.name)));
  const button=$('#submitExpenseBtn');button.disabled=true;button.textContent='Submitting…';
  try{
    const result=await api(revisionTarget?`/api/requests/${revisionTarget.id}/revise`:'/api/ecf/claims',
      {method:'POST',body:fd});
    cancelRevision();
    await loadMe();
    msg(`${result.refNo} submitted. Waiting for Checker.`);
  }catch(e){msg(e.message,'err');button.disabled=false;button.textContent='Submit Claim'}
};

const emsOriginalOpenRequest=openRequest;
openRequest=async function(id){
  await emsOriginalOpenRequest(id);
  if($('#detailModal').classList.contains('hidden')) return;
  try{
    const {request}=await api(`/api/requests/${id}`);
    emsDetail=request;
    if(request.form_type==='ECF'){
      $('#detailSummary').insertAdjacentHTML('beforeend',[
        ['Service order',request.service_order_number],
        ['Payment to',request.payment_to],['Bank',request.bank_name],['Account',request.account_number]
      ].map(([label,value])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join(''));
      $('.pdf-label').textContent='Expense Claim Form';
    }else $('.pdf-label').textContent='Expense Request Form';
    const checker=request.form_type==='ECF'&&request.status==='PENDING_CHECK'&&
      currentEmployee.ecfRole==='CHECKER'&&
      String(request.requester_email).toLowerCase()!==String(currentEmployee.email).toLowerCase();
    if(checker){$('#decisionPanel').classList.remove('hidden');$('#approveBtn').disabled=false}
  }catch(e){msg(e.message,'err')}
};

const emsOriginalSendDecision=sendDecision;
sendDecision=async function(decision){
  if(emsDetail?.form_type!=='ECF'||emsDetail.status!=='PENDING_CHECK')
    return emsOriginalSendDecision(decision);
  if(!sigRequireWorkflowSignature('check this claim')) return;
  const reason=$('#decisionReason').value.trim();
  if(decision==='REJECT'&&!reason) return;
  $('#approveBtn').disabled=true;$('#rejectBtn').disabled=true;
  try{
    const result=await api(`/api/requests/${currentDetailId}/check`,
      {method:'POST',body:JSON.stringify({decision,reason})});
    closeDetail();emsDetail=null;
    await loadMe();msg(`Claim updated to ${result.status}.`);
  }catch(e){msg(e.message,'err');$('#approveBtn').disabled=false;syncRejectButton()}
};

const emsOriginalCloseDetail=closeDetail;
closeDetail=function(){emsDetail=null;emsOriginalCloseDetail()};
