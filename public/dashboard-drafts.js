async function emsLoadDashboardRequests(){
  const filter=emsDashboardFilter,owner=currentEmployee?.email,sequence=++emsHistoryLoad;
  if(!filter)return;
  $('#decisionHistoryTable').classList.add('hidden');
  $('#decisionHistoryEmpty').classList.remove('hidden');
  $('#decisionHistoryEmpty').textContent='Loading…';
  $('#emsHistoryFilterLabel').textContent=`${filter.formType} · ${filter.state==='progress'?'In Progress':'Approved'}`;
  $('#emsHistoryPage').textContent='';
  $('#emsHistoryPrevious').disabled=true;$('#emsHistoryNext').disabled=true;
  try{
    const data=await api('/api/ems/dashboard/requests?'+new URLSearchParams(filter));
    if(sequence!==emsHistoryLoad||currentEmployee?.email!==owner||emsView!=='history')return;
    $('#decisionHistoryEmpty').textContent='No matching requests.';
    renderRequests(data.requests,'decisionHistoryTable','decisionHistoryBody','decisionHistoryEmpty');
    $('#emsHistoryPage').textContent=data.total?`${data.offset+1}–${Math.min(data.offset+data.requests.length,data.total)} of ${data.total}`:'0 requests';
    $('#emsHistoryPrevious').disabled=filter.offset===0;
    $('#emsHistoryNext').disabled=data.offset+data.limit>=data.total;
  }catch(e){if(sequence===emsHistoryLoad&&currentEmployee?.email===owner){$('#decisionHistoryEmpty').textContent='Unable to load requests. Click Refresh to retry.';msg(e.message,'err')}}
}
function emsHistoryPage(direction){
  if(!emsDashboardFilter)return;
  emsNavigate('history',{...emsDashboardFilter,offset:Math.max(0,emsDashboardFilter.offset+direction*50)});
}

function emsDraftStatus(){
  $('#draftSaveState').textContent=emsSavedDraft?`Draft saved · ${new Date(emsSavedDraft.updatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`:'';
}
function emsDraftForm(){
  const formType=emsView==='ecf'?'ECF':'ERF';
  const values=item=>({category:item.category,purpose:item.purpose,paymentDate:item.paymentDate,amount:item.amount});
  const editor={category:$('#category').value,purpose:$('#purpose').value,paymentDate:$('#paymentDate').value,amount:$('#amount').value};
  const form=new FormData();
  form.append('draft',JSON.stringify({formType,payments:payments.map(values),editor,editingIndex,serviceOrderNumber:$('#emsServiceOrder').value}));
  if(emsSavedDraft)form.append('version',String(emsSavedDraft.version));
  payments.forEach((payment,index)=>(payment.evidence||[]).forEach(file=>{
    if(!(file instanceof File))throw new Error('Reopen this draft to load its evidence before saving.');
    form.append(`payment_${index}`,file,file.name);
  }));
  selectedFiles().forEach(file=>form.append('editor',file,file.name));
  return form;
}
async function emsPersistDraft(){
  if(revisionTarget||!['erf','ecf'].includes(emsView))throw new Error('Draft is available for new requests.');
  const owner=currentEmployee?.email;
  const form=emsDraftForm();
  const draft=await api(emsSavedDraft?`/api/drafts/${emsSavedDraft.id}`:'/api/drafts',{method:emsSavedDraft?'PUT':'POST',body:form});
  if(currentEmployee?.email!==owner)throw new Error('Session changed. Reopen Draft after signing in.');
  emsSavedDraft={id:draft.id,version:draft.version,updatedAt:draft.updatedAt};
  emsStoreDraft();emsDraftStatus();return draft;
}
async function emsSaveDraft(){
  if(emsDraftBusy||emsSubmitting||executiveActionBusy)return;
  emsDraftBusy=true;
  $('#requestForm').inert=true;
  emsSetActionLoading($('#saveDraftBtn'),'Saving…');
  try{await emsPersistDraft();msg('Draft saved.')}catch(e){msg(e.message,'err')}
  finally{emsDraftBusy=false;$('#requestForm').inert=false;emsClearActionLoading($('#saveDraftBtn'),'Save Draft')}
}
async function emsSubmitForm(url,body){
  if(!emsSavedDraft||revisionTarget)return api(url,{method:'POST',body});
  // The saved snapshot is the submission source. A second tab must reopen after
  // a version conflict; retries after a committed request use the original ID.
  $('#requestForm').inert=true;
  try{
    if(!emsSavedDraft.committed)await emsPersistDraft();
    try{return await api(`/api/drafts/${emsSavedDraft.id}/submit`,{method:'POST',body:JSON.stringify({version:emsSavedDraft.version,...window.emsSubmissionOptions})})}
    catch(e){
      const current=await api(`/api/drafts/${emsSavedDraft.id}`).catch(()=>null);
      if(current?.committed)emsSavedDraft.committed=true;
      throw e;
    }
  }finally{$('#requestForm').inert=false}
}
let emsDraftListLoad=0;
async function emsLoadSavedDrafts(){
  const owner=currentEmployee?.email,sequence=++emsDraftListLoad;
  if(!owner||emsView!=='drafts')return;
  document.querySelectorAll('[data-new-draft]').forEach(button=>button.classList.toggle('hidden',!hasRole(currentEmployee,button.dataset.newDraft,'REQUESTOR')));
  $('#emsDraftRows').innerHTML='<div class="empty">Loading…</div>';
  try{
    const data=await api('/api/drafts');
    if(currentEmployee?.email!==owner||emsView!=='drafts'||sequence!==emsDraftListLoad)return;
    $('#emsDraftRows').innerHTML=data.drafts.length?`<div class="table-wrap"><table><thead><tr><th>Form</th><th>Purpose</th><th>Updated</th><th class="money">Total</th><th></th></tr></thead><tbody>${data.drafts.map(draft=>`<tr>
      <td><span class="role-chip">${esc(draft.formType)}</span></td><td class="draft-purpose">${esc(draft.purpose)}</td>
      <td>${esc(new Date(draft.updatedAt).toLocaleString())}</td><td class="money">${rupiah(draft.total)}</td>
      <td class="draft-list-actions"><button class="btn tiny ghost" data-draft-open="${esc(draft.id)}">Continue</button><button class="btn tiny danger" data-draft-delete="${esc(draft.id)}" data-version="${draft.version}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No saved drafts.</div>';
    $('#emsDraftRows').querySelectorAll('[data-draft-open]').forEach(button=>button.onclick=()=>emsOpenSavedDraft(button.dataset.draftOpen));
    $('#emsDraftRows').querySelectorAll('[data-draft-delete]').forEach(button=>button.onclick=()=>emsDeleteDraft(button.dataset.draftDelete,Number(button.dataset.version),button));
  }catch(e){if(currentEmployee?.email===owner&&sequence===emsDraftListLoad){$('#emsDraftRows').innerHTML='<div class="empty">Unable to load drafts. Click Refresh to retry.</div>';msg(e.message,'err')}}
}
async function emsOpenSavedDraft(id){
  if(emsDraftBusy||emsSubmitting)return;
  const owner=currentEmployee?.email;
  emsDraftBusy=true;$('#emsDrafts').inert=true;
  try{
    const draft=await api(`/api/drafts/${id}`);
    const attachments=await Promise.all(draft.files.map(async file=>{
      const response=await fetch(file.url);if(!response.ok)throw new Error('Unable to load draft evidence. Please retry.');
      return {...file,file:new File([await response.blob()],file.name,{type:file.type})};
    }));
    if(currentEmployee?.email!==owner)return;
    const evidence=field=>attachments.filter(f=>f.field===field).map(f=>f.file);
    const state=draft.payload,view=draft.formType.toLowerCase();
    emsStoreDraft();
    emsDrafts[view]={payments:state.payments.map((item,i)=>({...item,amount:Number(item.amount)||0,evidence:evidence(`payment_${i}`)})),
      ...state.editor,evidence:evidence('editor'),editingIndex:state.editingIndex,serviceOrderNumber:state.serviceOrderNumber,
      requestType:draft.formType==='ECF'?'REIMBURSEMENT':'EXPENSE',revisionTarget:null,
      savedDraft:{id:draft.id,version:draft.version,updatedAt:draft.updatedAt,committed:draft.committed}};
    emsFormView=null;emsDraftBusy=false;emsNavigate(view);
    if(draft.committed)msg('This draft already created a request. Submit again to finish without creating a duplicate.');
  }catch(e){msg(e.message,'err')}
  finally{emsDraftBusy=false;$('#emsDrafts').inert=false}
}
function emsNewDraft(view){
  if(emsDraftBusy||emsSubmitting)return;
  emsStoreDraft();delete emsDrafts[view];emsFormView=null;emsNavigate(view);
}
function emsDeleteConfirmation(){
  const modal=document.createElement('div');modal.className='modal';modal.id='draftDeleteModal';
  modal.innerHTML='<section class="approval-recall-panel" role="dialog" aria-modal="true" aria-labelledby="draftDeleteTitle"><h2 id="draftDeleteTitle">Delete draft?</h2><p>The saved form and its evidence will be deleted.</p><div class="executive-choice-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn danger" data-confirm>Delete</button></div></section>';
  const previous=document.activeElement;
  document.body.appendChild(modal);document.body.classList.add('modal-open');
  return new Promise(resolve=>{
    const close=value=>{modal.remove();if(!document.querySelector('.modal:not(.hidden)'))document.body.classList.remove('modal-open');previous?.focus();resolve(value)};
    modal.querySelector('[data-cancel]').onclick=()=>close(false);modal.querySelector('[data-confirm]').onclick=()=>close(true);
    modal.onclick=event=>{if(event.target===modal)close(false)};
    modal.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();close(false)}
      if(event.key==='Tab'){event.preventDefault();(document.activeElement===modal.querySelector('[data-cancel]')?modal.querySelector('[data-confirm]'):modal.querySelector('[data-cancel]')).focus()}
    };
    modal.querySelector('[data-cancel]').focus();
  });
}
async function emsDeleteDraft(id,version,button){
  if(emsDraftBusy||emsSubmitting)return;
  const owner=currentEmployee?.email;
  emsDraftBusy=true;
  try{
    if(!await emsDeleteConfirmation()||currentEmployee?.email!==owner)return;
    button.disabled=true;emsSetActionLoading(button,'Deleting…');
    await api(`/api/drafts/${id}`,{method:'DELETE',body:JSON.stringify({version})});
    for(const [view,draft] of Object.entries(emsDrafts))if(draft.savedDraft?.id===id)delete emsDrafts[view];
    if(emsSavedDraft?.id===id){emsSavedDraft=null;emsFormView=null}
    await emsLoadSavedDrafts();msg('Draft deleted.');
  }catch(e){msg(e.message,'err');button.disabled=false;emsClearActionLoading(button,'Delete')}
  finally{emsDraftBusy=false}
}
