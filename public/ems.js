// EMS navigation and ECF interaction extend the existing ERF form and detail UI.
let emsView='home';
let emsDetail=null;
let emsFormView=null;
let emsDraftOwner=null;
let emsDrafts={};
let emsSubmitting=false;
let emsChecking=false;

// Keep the original ERF options; ECF uses the claim category catalogue.
const emsErfCategories=[...document.querySelectorAll('#categoryMenu button')].map(button=>button.dataset.value);
const emsEcfCategories=[
  'Transportation','Accommodation','Meals','Office Supplies','Communication',
  'Project / Operational','Maintenance & Repair','Software / Subscription',
  'Training / Certification','Courier / Delivery','Others'
];

function emsSetCategories(view){
  closeCategoryMenu();
  const options=view==='ecf'?emsEcfCategories:emsErfCategories;
  const menu=$('#categoryMenu');
  menu.replaceChildren(...options.map(value=>{
    const button=document.createElement('button');
    button.type='button';
    button.dataset.value=value;
    button.textContent=value;
    button.addEventListener('click',()=>selectCategory(value));
    return button;
  }));
}

function emsStoreDraft(){
  if(!emsFormView) return;
  emsDrafts[emsFormView]={
    payments:payments.map(item=>({...item,evidence:[...(item.evidence||[])]})),
    editingIndex,
    revisionTarget:revisionTarget?{...revisionTarget}:null,
    requestType:rtRequestType,
    category:$('#category').value,
    purpose:$('#purpose').value,
    paymentDate:$('#paymentDate').value,
    amount:$('#amount').value,
    evidence:selectedFiles(),
    serviceOrderNumber:$('#emsServiceOrder').value
  };
}

function emsRestoreDraft(view){
  const draft=emsDrafts[view];
  emsFormView=view;
  emsSetCategories(view);
  payments=(draft?.payments||[]).map(item=>({...item,evidence:[...item.evidence]}));
  editingIndex=draft?.editingIndex??-1;
  revisionTarget=draft?.revisionTarget?{...draft.revisionTarget}:null;
  rtRequestType=draft?.requestType||(view==='ecf'?'REIMBURSEMENT':'EXPENSE');
  if(draft?.category) selectCategory(draft.category);
  else resetCategory();
  $('#purpose').value=draft?.purpose||'';
  $('#paymentDate').value=draft?.paymentDate||new Date().toISOString().slice(0,10);
  $('#amount').value=draft?.amount||'';
  const evidence=new DataTransfer();
  (draft?.evidence||[]).forEach(file=>evidence.items.add(file));
  $('#evidence').files=evidence.files;
  $('#emsServiceOrder').value=draft?.serviceOrderNumber||'';
  $('#addPaymentBtn').textContent=editingIndex>=0?'Update Payment':'+ Add Payment';
  renderPayments();
  renderRevisionState();
  syncEvidenceInfo();
}

function emsResetSessionState(){
  emsView='home';
  emsFormView=null;
  emsDraftOwner=null;
  emsDrafts={};
  payments=[];
  editingIndex=-1;
  revisionTarget=null;
  rtRequestType='EXPENSE';
  $('#emsServiceOrder').value='';
  renderPayments();
  resetPaymentForm();
  renderRevisionState();
  emsCloseSidebar();
}

function emsCloseSidebar(){
  $('#emsNav').classList.remove('open');
  $('#emsNavBackdrop').classList.remove('open');
  $('#emsSidebarToggle').setAttribute('aria-expanded','false');
  $('#emsSidebarToggle').setAttribute('aria-label','Open navigation');
}

function emsToggleSidebar(){
  const open=!$('#emsNav').classList.contains('open');
  $('#emsNav').classList.toggle('open',open);
  $('#emsNavBackdrop').classList.toggle('open',open);
  $('#emsSidebarToggle').setAttribute('aria-expanded',String(open));
  $('#emsSidebarToggle').setAttribute('aria-label',open?'Close navigation':'Open navigation');
}

function emsSetActionLoading(button,label){
  if(!button) return;
  if(window.rtInjectStyles) rtInjectStyles();
  button.classList.add('decision-action-loading');
  button.setAttribute('aria-busy','true');
  button.innerHTML=`<span class="decision-spinner" aria-hidden="true"></span>${esc(label)}`;
}

function emsClearActionLoading(button,label){
  if(!button) return;
  button.classList.remove('decision-action-loading');
  button.removeAttribute('aria-busy');
  button.textContent=label;
}

function emsNavigate(view){
  if(!currentEmployee) return;
  if(emsSubmitting && view!==emsView) return;
  emsCloseSidebar();
  const admin=currentEmployee.role==='ADMIN';
  if(admin && !['home','admin-users','admin-app'].includes(view)) view='admin-users';
  if(!admin && view.startsWith('admin-')) view='home';
  const canRequest=hasRole(currentEmployee,'ERF','REQUESTOR')||hasRole(currentEmployee,'ECF','REQUESTOR');
  const canWork=['ERF','ECF'].some(form=>rolesFor(currentEmployee,form).some(role=>role!=='REQUESTOR'));
  if(!admin && ['erf','ecf'].includes(view) && !hasRole(currentEmployee,view.toUpperCase(),'REQUESTOR')) view='home';
  if(!admin && view==='requests' && !canRequest) view='home';
  if(!admin && view==='tasks' && !canWork) view='home';
  if(!admin && view==='history' && !canRequest && !canWork) view='home';
  if(!admin && ['erf','ecf'].includes(view) && view!==emsFormView){
    emsStoreDraft();
    emsRestoreDraft(view);
  }
  emsView=view;
  document.querySelectorAll('#emsNav [data-ems-view]').forEach(button=>{
    const active=button.dataset.emsView===view;
    button.classList.toggle('active',active);
    if(active) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  if(view.startsWith('admin-')) showAdminSection(view==='admin-app'?'app':'users');
  $('#emsHome').classList.toggle('hidden',view!=='home');
  $('#emsTasks').classList.toggle('hidden',view!=='tasks');
  $('#decisionHistoryCard').classList.toggle('hidden',view!=='history');
  $('#workflowDashboard').classList.toggle('hidden',!['erf','ecf','requests'].includes(view));
  $('#adminDashboard').classList.toggle('hidden',!view.startsWith('admin-'));
  $('#requestQueueCard').classList.toggle('hidden',!['erf','ecf','requests'].includes(view));
  const canCreate=(view==='erf' && hasRole(currentEmployee,'ERF','REQUESTOR')) ||
    (view==='ecf' && hasRole(currentEmployee,'ECF','REQUESTOR'));
  $('#requestForm').classList.toggle('hidden',!canCreate);
  $('#emsClaimFields').classList.toggle('hidden',view!=='ecf');
  if(view==='erf'||view==='ecf'||view==='requests'){
    $('#queueTitle').textContent=view==='requests'?'My Requests':view==='erf'?'Expense Requests':'Expense Claims';
    const data=window.emsBootstrap||{};
    const source=view==='ecf'&&!hasRole(currentEmployee,'ECF','REQUESTOR')
      ? data.tasks||[] : data.requests||[];
    const rows=view==='requests'?data.myRequests||[]:
      source.filter(row=>row.form_type===(view==='ecf'?'ECF':'ERF'));
    renderRequests(rows);
  }
  if(view==='ecf'){
    rtRequestType='REIMBURSEMENT';
    rtApplyUi();
    if(!revisionTarget) $('#requestFormTitle').textContent='Create Expense Claim';
    $('#submitExpenseBtn').textContent=revisionTarget?'Submit Revision':'Submit Claim';
  }else if(view==='erf'){
    if(!revisionTarget) rtRequestType='EXPENSE';
    rtApplyUi();
  }
  $('#evidenceModeNote')?.classList.toggle('hidden',view==='ecf');
  if(view==='tasks') emsRenderTasks();
  if(view==='history'){
    const data=window.emsBootstrap||{};
    $('#decisionHistoryTitle').textContent='Activity History';
    renderRequests(data.history||[],'decisionHistoryTable','decisionHistoryBody','decisionHistoryEmpty');
  }
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
      <button class="btn tiny primary" onclick="openRequest('${row.id}')">${row.task_role==='CHECKER'?'Check':row.task_role==='APPROVER'?'Approve':'Review'}</button>
    </div>`).join(''):'<div class="empty">No pending tasks.</div>';
}

function emsDashboardIcon(name,tone='navy'){
  return `<span class="ems-metric-icon ${tone}" style="--icon:var(--icon-${name})" aria-hidden="true"></span>`;
}

function emsRenderTrend(rows,types){
  const dates=rows.map(row=>row.month).filter(month=>/^\d{4}-\d{2}$/.test(month)).sort();
  if(!dates.length) return '<div class="ems-chart-empty">No approved transactions in the last six months.</div>';
  const parts=new Intl.DateTimeFormat('en',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  const latest=[Number(parts.find(part=>part.type==='year').value),Number(parts.find(part=>part.type==='month').value)];
  const months=Array.from({length:6},(_,i)=>{
    const date=new Date(Date.UTC(latest[0],latest[1]-6+i,1));
    return {key:date.toISOString().slice(0,7),label:date.toLocaleDateString('en-GB',{month:'short',timeZone:'UTC'})};
  });
  const amounts=months.map(month=>types.map(type=>rows.filter(row=>row.month===month.key&&row.form_type===type)
    .reduce((sum,row)=>sum+Math.max(0,Number(row.amount)||0),0)));
  const peak=Math.max(1,...amounts.flat());
  const magnitude=10**Math.floor(Math.log10(peak));
  const ceiling=Math.ceil(peak/magnitude)*magnitude;
  const short=value=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
  const colors={ERF:'#0b3768',ECF:'#329b97'};
  let svg='<svg class="ems-trend-svg" viewBox="0 0 600 270" role="img" aria-label="Approved monthly amounts. Exact values are available in the table below.">';
  for(let tick=0;tick<=4;tick++){
    const y=220-tick*47;
    svg+=`<line x1="58" x2="586" y1="${y}" y2="${y}" stroke="#e9edf3" stroke-dasharray="3 4"/><text x="48" y="${y+4}" text-anchor="end">${short(ceiling*tick/4)}</text>`;
  }
  months.forEach((month,i)=>{
    const center=102+i*88;
    types.forEach((type,j)=>{
      const height=amounts[i][j]/ceiling*188;
      const x=center-(types.length*20)/2+j*20;
      svg+=`<rect x="${x}" y="${220-height}" width="16" height="${height}" rx="3" fill="${colors[type]}"><title>${month.key} · ${type}: ${rupiah(amounts[i][j])}</title></rect>`;
    });
    svg+=`<text x="${center}" y="244" text-anchor="middle">${month.label}</text>`;
  });
  svg+='</svg>';
  const legend=`<div class="ems-chart-legend">${types.map(type=>`<span><i style="background:${colors[type]}"></i>${type}</span>`).join('')}<small>Amounts in IDR</small></div>`;
  const table=`<details class="ems-chart-data"><summary>View monthly amounts</summary><div class="table-wrap"><table><thead><tr><th>Month</th>${types.map(type=>`<th class="money">${type}</th>`).join('')}</tr></thead><tbody>${months.map((month,i)=>`<tr><td>${month.key}</td>${amounts[i].map(value=>`<td class="money">${rupiah(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  return legend+svg+table;
}

function emsRenderDistribution(series){
  const total=series.reduce((sum,row)=>sum+row.value,0);
  if(total<=0) return '<div class="ems-chart-empty">No approved amounts yet.</div>';
  let offset=0;
  const arcs=series.map(row=>{
    const share=row.value/total*100;
    const arc=`<circle cx="110" cy="110" r="82" pathLength="100" fill="none" stroke="${row.color}" stroke-width="24" stroke-dasharray="${share} ${100-share}" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"><title>${row.label}: ${rupiah(row.value)}</title></circle>`;
    offset+=share;return arc;
  }).join('');
  return `<div class="ems-donut"><svg viewBox="0 0 220 220" role="img" aria-label="Approved amount distribution">${arcs}</svg><div class="ems-donut-center"><small>Total approved</small><strong>${rupiah(total)}</strong></div></div><div class="ems-distribution-legend">${series.map(row=>`<div><span><i style="background:${row.color}"></i>${row.label}</span><strong>${rupiah(row.value)}</strong><small>${Math.round(row.value/total*100)}%</small></div>`).join('')}</div>`;
}

async function emsLoadDashboard(){
  if(!currentEmployee || employeeNeedsSetup()) return;
  const owner=currentEmployee.email;
  try{
    const data=await api('/api/ems/dashboard');
    if(currentEmployee?.email!==owner) return;
    const erfAccess=currentEmployee.role==='ADMIN'||rolesFor(currentEmployee,'ERF').length>0;
    const ecfAccess=currentEmployee.role==='ADMIN'||rolesFor(currentEmployee,'ECF').length>0;
    const types=[...(erfAccess?['ERF']:[]),...(ecfAccess?['ECF']:[])];
    const total=(type,states,field)=>data.totals.filter(row=>row.form_type===type&&states.includes(row.status))
      .reduce((sum,row)=>sum+Math.max(0,Number(row[field])||0),0);
    const requested=total('ERF',['APPROVED'],'amount');
    const claimed=total('ECF',['APPROVED'],'amount');
    const pending=['PENDING_CHECK','PENDING_REVIEW','PENDING_APPROVAL'];
    const metrics=[
      ...(erfAccess?[{label:'Approved ERF',value:requested,icon:'file',tone:'navy',subtitle:`${total('ERF',['APPROVED'],'count')} approved request${total('ERF',['APPROVED'],'count')===1?'':'s'}`}]:[]),
      ...(ecfAccess?[
        {label:'Approved ECF',value:claimed,icon:'claim',tone:'teal',subtitle:`${total('ECF',['APPROVED'],'count')} approved claim${total('ECF',['APPROVED'],'count')===1?'':'s'}`},
        {label:'ECF in progress',value:total('ECF',pending,'amount'),icon:'history',tone:'amber',subtitle:`${total('ECF',pending,'count')} claim${total('ECF',pending,'count')===1?'':'s'} awaiting action`}
      ]:[])
    ];
    $('#emsMetrics').style.gridTemplateColumns=`repeat(${Math.max(1,metrics.length)},minmax(0,1fr))`;
    $('#emsMetrics').innerHTML=metrics.map(metric=>
      `<div class="ems-metric">${emsDashboardIcon(metric.icon,metric.tone)}<div class="ems-metric-copy"><small>${metric.label}</small><strong>${rupiah(metric.value)}</strong><span>${metric.subtitle}</span></div></div>`).join('') ||
      '<div class="empty">No modules assigned yet.</div>';
    $('#emsTrend').innerHTML=emsRenderTrend(data.trend.filter(row=>types.includes(row.form_type)),types);
    $('#emsDistribution').innerHTML=emsRenderDistribution([
      ...(erfAccess?[{label:'ERF',value:requested,color:'#0b3768'}]:[]),
      ...(ecfAccess?[{label:'ECF',value:claimed,color:'#329b97'}]:[])
    ]);
    const categories=data.categories.filter(row=>types.includes(row.form_type));
    const highest=Math.max(1,...categories.map(row=>Number(row.amount)||0));
    $('#emsCategories').innerHTML=categories.length?`<div class="table-wrap"><table><thead><tr><th>Category</th><th>Form</th><th class="ems-category-share">Relative amount</th><th class="money">Amount (IDR)</th></tr></thead><tbody>${categories.map(row=>
      `<tr><td>${esc(row.category)}</td><td><span class="role-chip">${esc(row.form_type)}</span></td><td class="ems-category-share"><span class="ems-category-track"><i style="width:${Math.max(0,Number(row.amount)||0)/highest*100}%"></i></span></td><td class="money"><strong>${rupiah(row.amount)}</strong></td></tr>`
    ).join('')}</tbody></table></div>`:'<div class="empty">No approved categories this month.</div>';
  }catch(e){
    if(currentEmployee?.email!==owner) return;
    for(const id of ['emsMetrics','emsTrend','emsDistribution','emsCategories'])
      $('#'+id).innerHTML='<div class="empty">Dashboard data could not be loaded. Reopen Dashboard to retry.</div>';
    msg(e.message,'err');
  }
}

const emsOriginalLoadMe=loadMe;
loadMe=async function(...args){
  await emsOriginalLoadMe(...args);
  if(!currentEmployee||employeeNeedsSetup()) return;
  const admin=currentEmployee.role==='ADMIN';
  const canRequest=hasRole(currentEmployee,'ERF','REQUESTOR')||hasRole(currentEmployee,'ECF','REQUESTOR');
  const canWork=['ERF','ECF'].some(form=>rolesFor(currentEmployee,form).some(role=>role!=='REQUESTOR'));
  $('#emsTransactionsNav').classList.toggle('hidden',admin ||
    (!hasRole(currentEmployee,'ERF','REQUESTOR') && !hasRole(currentEmployee,'ECF','REQUESTOR')));
  $('#emsActivityNav').classList.toggle('hidden',admin || (!canRequest && !canWork));
  $('#emsNav [data-ems-view="requests"]').classList.toggle('hidden',!canRequest);
  $('#emsNav [data-ems-view="tasks"]').classList.toggle('hidden',!canWork);
  $('#emsNav [data-ems-view="history"]').classList.toggle('hidden',!canRequest&&!canWork);
  $('#emsAdminNav').classList.toggle('hidden',!admin);
  $('#emsNav [data-ems-view="erf"]').classList.toggle('hidden',!hasRole(currentEmployee,'ERF','REQUESTOR'));
  $('#emsNav [data-ems-view="ecf"]').classList.toggle('hidden',!hasRole(currentEmployee,'ECF','REQUESTOR'));
  $('#profile').classList.toggle('hidden',admin);
  const legacyTitle=admin?'Admin Dashboard':
    currentEmployee.role==='REVIEWER'?'Reviewer Dashboard':
    currentEmployee.role==='APPROVER'?'Approver Dashboard':
    currentEmployee.ecfRole==='CHECKER' && currentEmployee.role==='REQUESTOR'
      ? 'Requestor & Checker Dashboard':
    currentEmployee.ecfRole==='CHECKER'?'Checker Dashboard':
    currentEmployee.role==='NONE'
      ? currentEmployee.ecfRole==='REQUESTOR'?'ECF Requestor Dashboard':'Dashboard'
      : 'Requestor Dashboard';
  const roleLabels=[...new Set([...rolesFor(currentEmployee,'ERF'),...rolesFor(currentEmployee,'ECF')])];
  $('#roleTitle').textContent=currentEmployee.workflow_roles==null?legacyTitle:roleLabels.length===1?`${roleLabels[0][0]}${roleLabels[0].slice(1).toLowerCase()} Dashboard`:'Dashboard';
  const tasks=window.emsBootstrap?.tasks||[];
  $('#emsTaskCount').textContent=tasks.length?String(tasks.length):'';
  if(emsDraftOwner!==currentEmployee.email){
    emsResetSessionState();
    emsDraftOwner=currentEmployee.email;
  }
  emsNavigate(emsView);
};

const emsOriginalStartRevision=startRevision;
startRevision=async function(id){
  if(emsSubmitting) return;
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
  if(emsSubmitting) return;
  if(!['erf','ecf'].includes(emsView)) return;
  if(revisionTarget && revisionTarget.formType!==(emsView==='ecf'?'ECF':'ERF'))
    return msg('Open this revision from My Requests before submitting.','err');
  if(emsView!=='ecf'){
    emsSubmitting=true;
    try{return await emsOriginalSubmitExpense()}
    finally{emsSubmitting=false}
  }
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
  const button=$('#submitExpenseBtn');
  const submittingRevision=Boolean(revisionTarget);
  button.disabled=true;
  emsSetActionLoading(button,submittingRevision?'Submitting Revision…':'Submitting…');
  emsSubmitting=true;
  try{
    const result=await api(revisionTarget?`/api/requests/${revisionTarget.id}/revise`:'/api/ecf/claims',
      {method:'POST',body:fd});
    cancelRevision();
    await loadMe();
    msg(`${result.refNo} submitted. Waiting for Checker.`);
  }catch(e){
    msg(e.message,'err');
    button.disabled=false;
    emsClearActionLoading(button,submittingRevision?'Submit Revision':'Submit Claim');
  }
  finally{
    emsSubmitting=false;
    emsClearActionLoading(button,revisionTarget?'Submit Revision':'Submit Claim');
    button.disabled=!payments.length;
  }
};

const emsOriginalOpenRequest=openRequest;
openRequest=async function(id){
  await emsOriginalOpenRequest(id);
  if($('#detailModal').classList.contains('hidden')) return;
  try{
    const {request}=await api(`/api/requests/${id}`);
    emsDetail=request;
    currentDecisionRole=assignedRole(currentEmployee,request);
    if(request.form_type==='ECF'){
      $('.pdf-label').textContent='Expense Claim Form';
    }else $('.pdf-label').textContent='Expense Request Form';
    const checker=request.form_type==='ECF'&&request.status==='PENDING_CHECK'&&
      assignedRole(currentEmployee,request)==='CHECKER';
    if(checker){$('#decisionPanel').classList.remove('hidden');$('#approveBtn').disabled=false}
  }catch(e){msg(e.message,'err')}
};

const emsOriginalSendDecision=sendDecision;
sendDecision=async function(decision){
  if(emsChecking) return;
  if(emsDetail?.form_type!=='ECF'||emsDetail.status!=='PENDING_CHECK')
    return emsOriginalSendDecision(decision);
  if(!sigRequireWorkflowSignature('check this claim')) return;
  const reason=$('#decisionReason').value.trim();
  if(decision==='REJECT'&&!reason) return;
  const activeButton=decision==='APPROVE'?$('#approveBtn'):$('#rejectBtn');
  const activeLabel=decision==='APPROVE'?'Approve':'Reject';
  emsChecking=true;
  $('#decisionReason').disabled=true;
  emsSetActionLoading(activeButton,decision==='APPROVE'?'Approving…':'Rejecting…');
  $('#approveBtn').disabled=true;$('#rejectBtn').disabled=true;
  try{
    const result=await api(`/api/requests/${currentDetailId}/check`,
      {method:'POST',body:JSON.stringify({decision,reason})});
    closeDetail();emsDetail=null;
    await loadMe();msg(`Claim updated to ${result.status}.`);
  }catch(e){
    msg(e.message,'err');
    $('#approveBtn').disabled=false;
    syncRejectButton();
  }finally{
    emsChecking=false;
    $('#decisionReason').disabled=false;
    emsClearActionLoading(activeButton,activeLabel);
    if(currentDetailId) syncRejectButton();
  }
};

const emsOriginalCloseDetail=closeDetail;
closeDetail=function(){emsDetail=null;emsOriginalCloseDetail()};

const emsOriginalLogout=logout;
logout=async function(...args){
  await emsOriginalLogout(...args);
  emsResetSessionState();
  window.emsBootstrap=null;
  emsDetail=null;
  ['#emsTransactionsNav','#emsActivityNav','#emsAdminNav'].forEach(selector=>
    $(selector).classList.add('hidden'));
};

// One entry point, after app.js, request-type.js and the ECF extensions.
loadAuthMode();
loadMe();

// Close the mobile drawer when switching viewport; disclosure choices persist.
const emsCompactNavigation=window.matchMedia('(max-width: 1100px)');
emsCompactNavigation.addEventListener('change',()=>{
  emsCloseSidebar();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && document.querySelector('#emsNav.open')){
    emsCloseSidebar();
    $('#emsSidebarToggle').focus();
  }
});
