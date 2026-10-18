let executiveChoiceResolve=null;
let executiveActionBusy=false;
let executiveReturnFocus=null;

function executiveChoice(takeover=false){
  if(executiveChoiceResolve)return Promise.resolve(null);
  let modal=$('#executiveChoiceModal');
  if(!modal){
    modal=document.createElement('div');modal.id='executiveChoiceModal';modal.className='modal hidden';
    modal.innerHTML=`<form class="approval-recall-panel" role="dialog" aria-modal="true" aria-labelledby="executiveChoiceTitle" aria-describedby="executiveChoiceDescription">
      <h2 id="executiveChoiceTitle"></h2><p id="executiveChoiceDescription"></p>
      <label for="executiveChoiceReason" id="executiveChoiceReasonLabel"></label>
      <textarea id="executiveChoiceReason" rows="3" maxlength="4000"></textarea>
      <div class="executive-choice-actions">
        <button class="btn ghost" type="button" data-choice="cancel">Cancel</button>
        <button class="btn primary" type="button" data-choice="normal">Normal Workflow</button>
        <button class="btn danger" type="submit" data-choice="confirm" disabled></button>
      </div></form>`;
    document.body.appendChild(modal);
    modal.querySelector('form').onsubmit=e=>{e.preventDefault();if($('#executiveChoiceReason').value.trim())finishExecutiveChoice(true)};
    modal.querySelector('[data-choice="normal"]').onclick=()=>finishExecutiveChoice(false);
    modal.querySelector('[data-choice="cancel"]').onclick=()=>finishExecutiveChoice(null);
    modal.onclick=e=>{if(e.target===modal)finishExecutiveChoice(null)};
    $('#executiveChoiceReason').oninput=()=>{modal.querySelector('[data-choice="confirm"]').disabled=!$('#executiveChoiceReason').value.trim()};
    modal.onkeydown=e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finishExecutiveChoice(null)}
      if(e.key==='Tab'){
        const nodes=[...modal.querySelectorAll('button:not([disabled]),textarea')].filter(n=>!n.classList.contains('hidden'));
        const first=nodes[0],last=nodes.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
        if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
      }
    };
  }
  $('#executiveChoiceTitle').textContent=takeover?'Take Over':'Submission Workflow';
  $('#executiveChoiceDescription').textContent=takeover
    ?'Take responsibility for this stage. You will still need to approve or reject it separately.'
    :'Do you want to bypass review and check? Bypass sends this request to your own Pending Approval queue; final approval is still required.';
  $('#executiveChoiceReasonLabel').textContent=takeover?'Takeover reason':'Reason for bypass (required only for bypass)';
  $('#executiveChoiceReason').value='';
  modal.querySelector('[data-choice="normal"]').classList.toggle('hidden',takeover);
  const confirm=modal.querySelector('[data-choice="confirm"]');confirm.textContent=takeover?'Take Over':'Bypass to Approval';confirm.disabled=true;
  executiveReturnFocus=document.activeElement;
  modal.classList.remove('hidden');document.body.classList.add('modal-open');
  (takeover?$('#executiveChoiceReason'):modal.querySelector('[data-choice="normal"]')).focus();
  return new Promise(resolve=>executiveChoiceResolve=resolve);
}
function finishExecutiveChoice(choice){
  const resolve=executiveChoiceResolve;if(!resolve)return;
  const reason=$('#executiveChoiceReason').value.trim();
  $('#executiveChoiceModal').classList.add('hidden');executiveChoiceResolve=null;
  if(!document.querySelector('.modal:not(.hidden)'))document.body.classList.remove('modal-open');
  executiveReturnFocus?.focus();
  resolve(choice===null?null:{bypass:choice,bypassReason:choice?reason:''});
}

const executiveOriginalSubmit=submitExpense;
submitExpense=async function(){
  if(executiveActionBusy||emsSubmitting||!payments.length)return;
  const form=emsView==='ecf'?'ECF':'ERF';
  if(!['ecf','erf'].includes(emsView)||!sigRequireWorkflowSignature('submit this request'))return;
  executiveActionBusy=true;
  try{
    const choice=canBypass(currentEmployee,form)?await executiveChoice():{bypass:false,bypassReason:''};
    if(!choice)return;
    window.emsSubmissionOptions=choice;
    await executiveOriginalSubmit();
  }finally{window.emsSubmissionOptions=null;executiveActionBusy=false}
};

const executiveOriginalOpen=openRequest;
openRequest=async function(id){
  await executiveOriginalOpen(id);
  let button=$('#takeOverBtn');
  if(!button){
    button=document.createElement('button');button.id='takeOverBtn';button.type='button';button.className='btn danger hidden';
    $('.modal-head-actions').prepend(button);button.onclick=takeOverCurrentRequest;
  }
  const role=emsDetail?.id===id?takeoverRole(currentEmployee,emsDetail):null;
  button.textContent=role==='CHECKER'?'Take Over Check':'Take Over Review';
  button.classList.toggle('hidden',!role);
};
async function takeOverCurrentRequest(){
  if(executiveActionBusy||!emsDetail||!takeoverRole(currentEmployee,emsDetail))return;
  executiveActionBusy=true;
  const id=emsDetail.id,revision=emsDetail.revision,button=$('#takeOverBtn');
  try{
    const choice=await executiveChoice(true);if(!choice)return;
    button.disabled=true;button.textContent='Taking Over…';
    await api(`/api/requests/${id}/takeover`,{method:'POST',body:JSON.stringify({reason:choice.bypassReason,revision})});
    await loadMe();await openRequest(id);
    msg('Stage taken over. You can now approve or reject it.','ok');
  }catch(e){msg(e.message,'err')}
  finally{button.disabled=false;executiveActionBusy=false}
}
