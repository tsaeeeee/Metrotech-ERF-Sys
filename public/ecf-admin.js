// Workflow access is saved atomically with the user's master data.
function adminSelectedWorkflowRoles(){
  return Object.fromEntries(Object.keys(FORM_ROLES).map(form=>[form,
    [...document.querySelectorAll(`#adminWorkflowRoles input[data-form="${form}"]:checked`)].map(input=>input.value)]));
}
function adminRoleText(user,form){
  return rolesFor({...user,active:true},form).map(role=>role[0]+role.slice(1).toLowerCase()).join(', ')||'No Access';
}
function adminWorkflowSelect(id,label,attributes,choices,value){
  return `<div class="field workflow-select-field">
    <label id="${id}Label" for="${id}Button">${label}</label>
    <select id="${id}" ${attributes} hidden tabindex="-1" aria-hidden="true">${choices.map(([key,text])=>`<option value="${key}" ${key===value?'selected':''}>${text}</option>`).join('')}</select>
    <div class="custom-select" data-workflow-select="${id}">
      <button id="${id}Button" type="button" class="custom-select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}Menu" aria-labelledby="${id}Label ${id}Value">
        <span id="${id}Value"></span><span class="custom-select-chevron" aria-hidden="true">⌄</span>
      </button>
      <div id="${id}Menu" class="custom-select-menu hidden" role="listbox" aria-labelledby="${id}Label">${choices.map(([key,text])=>`<button type="button" role="option" tabindex="-1" data-value="${key}" aria-selected="false">${text}</button>`).join('')}</div>
    </div>
  </div>`;
}
function closeAdminWorkflowMenus(){
  document.querySelectorAll('[data-workflow-select]').forEach(control=>{
    control.classList.remove('open','opens-up');
    control.querySelector('.custom-select-menu').classList.add('hidden');
    control.querySelector('.custom-select-trigger').setAttribute('aria-expanded','false');
  });
}
function syncAdminWorkflowSelects(){
  document.querySelectorAll('[data-workflow-select]').forEach(control=>{
    const select=document.getElementById(control.dataset.workflowSelect),trigger=control.querySelector('.custom-select-trigger');
    trigger.disabled=select.disabled;
    trigger.querySelector('span').textContent=select.selectedOptions[0]?.textContent||'';
    control.querySelectorAll('[role=option]').forEach(button=>{
      const selected=button.dataset.value===select.value;
      button.disabled=select.disabled||[...select.options].find(option=>option.value===button.dataset.value).disabled;
      button.classList.toggle('selected',selected);button.setAttribute('aria-selected',String(selected));
    });
  });
}
function openAdminWorkflowMenu(control,edge){
  const trigger=control.querySelector('.custom-select-trigger');if(trigger.disabled)return;
  closeAdminWorkflowMenus();
  const menu=control.querySelector('.custom-select-menu');
  menu.style.maxHeight='';menu.classList.remove('hidden');control.classList.add('open');
  trigger.setAttribute('aria-expanded','true');
  const panel=control.closest('.profile-modal-panel'),rect=trigger.getBoundingClientRect(),bounds=panel.getBoundingClientRect();
  const below=Math.min(bounds.bottom,innerHeight)-rect.bottom-12;
  const above=rect.top-Math.max(bounds.top,panel.querySelector('.modal-head').getBoundingClientRect().bottom)-12;
  const up=below<menu.scrollHeight&&above>below;
  control.classList.toggle('opens-up',up);menu.style.maxHeight=`${Math.max(36,Math.min(292,up?above:below))}px`;
  const options=[...menu.querySelectorAll('[role=option]:not(:disabled)')];
  (edge==='last'?options.at(-1):edge==='first'?options[0]:options.find(button=>button.getAttribute('aria-selected')==='true')||options[0])?.focus({preventScroll:true});
}
document.addEventListener('click',event=>{
  const control=event.target.closest('[data-workflow-select]');
  if(!control){closeAdminWorkflowMenus();return}
  const choice=event.target.closest('[role=option]');
  if(choice&&!choice.disabled){
    const select=document.getElementById(control.dataset.workflowSelect);
    select.value=choice.dataset.value;select.dispatchEvent(new Event('change',{bubbles:true}));
    syncAdminWorkflowSelects();closeAdminWorkflowMenus();control.querySelector('.custom-select-trigger').focus({preventScroll:true});
  }else if(event.target.closest('.custom-select-trigger')){
    if(control.classList.contains('open'))closeAdminWorkflowMenus();else openAdminWorkflowMenu(control);
  }
});
document.addEventListener('keydown',event=>{
  const control=event.target.closest('[data-workflow-select]');if(!control)return;
  const open=control.classList.contains('open'),trigger=control.querySelector('.custom-select-trigger');
  if(event.key==='Escape'){event.preventDefault();closeAdminWorkflowMenus();trigger.focus({preventScroll:true});return}
  if(event.key==='Tab'){closeAdminWorkflowMenus();trigger.focus({preventScroll:true});return}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();
  if(!open){openAdminWorkflowMenu(control,event.key==='ArrowUp'||event.key==='End'?'last':'first');return}
  const options=[...control.querySelectorAll('[role=option]:not(:disabled)')],index=options.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
  options[next]?.focus({preventScroll:true});
});
const workflowOriginalRenderAdminUsers=renderAdminUsers;
renderAdminUsers=function(){
  workflowOriginalRenderAdminUsers();
  const header=document.querySelector('#adminUsersTable thead tr');
  header.children[4].textContent='ERF Access';
  if(!document.getElementById('adminEcfAccessHeader')){
    const th=document.createElement('th');th.id='adminEcfAccessHeader';th.textContent='ECF Access';
    header.children[4].insertAdjacentElement('afterend',th);
  }
  document.querySelectorAll('#adminUsersBody tr').forEach((row,index)=>{
    const user=adminUsers[index];if(!user)return;
    row.children[4].textContent=adminRoleText(user,'ERF');
    const cell=document.createElement('td');cell.textContent=adminRoleText(user,'ECF');
    row.children[4].insertAdjacentElement('afterend',cell);
  });
};
const workflowOriginalOpenAdminUserModal=openAdminUserModal;
openAdminUserModal=function(encodedEmail=''){
  workflowOriginalOpenAdminUserModal(encodedEmail);
  const user=encodedEmail?adminUsers.find(u=>u.email===decodeURIComponent(encodedEmail)):null;
  const roleField=document.querySelector('#adminUserForm .admin-role-field');
  roleField.classList.add('hidden');
  let field=document.getElementById('adminWorkflowRoles');
  if(!field){
    field=document.createElement('div');field.id='adminWorkflowRoles';field.className='span-2 workflow-role-fields';
    roleField.insertAdjacentElement('afterend',field);
  }
  const assignedApprover=adminUsers.find(u=>u.active && ['ERF','ECF'].some(form=>rolesFor(u,form).includes('APPROVER')));
  field.innerHTML=Object.entries(FORM_ROLES).map(([form,roles])=>{
    const selected=user?rolesFor({...user,active:true},form):form==='ERF'?['REQUESTOR']:[];
    return `<fieldset><legend>${form} Access</legend><div class="workflow-role-options">${roles.map(role=>{
      const locked=role==='APPROVER'&&assignedApprover&&!sameEmail(assignedApprover.email,user?.email);
      return `<label><input type="checkbox" data-form="${form}" value="${role}" ${selected.includes(role)?'checked':''} ${locked?'disabled':''}>${role[0]+role.slice(1).toLowerCase()}</label>`;
    }).join('')}</div></fieldset>`;
  }).join('');
  let optionsField=$('#adminWorkflowOptions');
  if(!optionsField){optionsField=document.createElement('div');optionsField.id='adminWorkflowOptions';optionsField.className='span-2 workflow-role-fields';field.insertAdjacentElement('afterend',optionsField)}
  const options=user?.workflow_options||{};
  optionsField.innerHTML=`<div class="field workflow-display-name"><label for="adminWorkflowDisplayName">Workflow display name</label><input id="adminWorkflowDisplayName" maxlength="40" value="${esc(options.displayName||'')}" placeholder="Short name (optional)"></div>`+['ERF','ECF'].map(form=>{
    const option=options[form]||{};
    return `<fieldset><legend>${form} Workflow</legend>
      ${adminWorkflowSelect('adminWorkflowReview'+form,'Reviewer assignment',`data-workflow-review="${form}"`,[['ASSIGNED','Individual assignment'],['PRIMARY','Primary — shared queue'],['SECONDARY','Secondary — manual takeover']],option.review||'ASSIGNED')}
      ${form==='ECF'?adminWorkflowSelect('adminWorkflowCheck','Checker assignment','',[['PRIMARY','Primary'],['SECONDARY','Secondary — manual takeover']],option.check||'PRIMARY'):''}
      <label class="workflow-bypass-option"><input type="checkbox" data-workflow-bypass="${form}" ${option.bypass?'checked':''}> Allow bypass on own requests</label>
      </fieldset>`;
  }).join('');
  const sync=()=>{
    const selected=adminSelectedWorkflowRoles();
    for(const form of ['ERF','ECF']){
      const roles=selected[form],review=optionsField.querySelector(`[data-workflow-review="${form}"]`),bypass=optionsField.querySelector(`[data-workflow-bypass="${form}"]`);
      review.disabled=!roles.includes('REVIEWER');if(review.disabled)review.value='ASSIGNED';
      review.querySelector('[value="SECONDARY"]').disabled=!roles.includes('APPROVER');
      if(review.value==='SECONDARY'&&!roles.includes('APPROVER'))review.value='ASSIGNED';
      bypass.disabled=!(roles.includes('APPROVER')&&roles.includes('REQUESTOR'));if(bypass.disabled)bypass.checked=false;
    }
    const check=$('#adminWorkflowCheck');check.disabled=!selected.ECF.includes('CHECKER');
    check.querySelector('[value="SECONDARY"]').disabled=!selected.ECF.includes('APPROVER');
    if(check.disabled||!selected.ECF.includes('APPROVER'))check.value='PRIMARY';
    closeAdminWorkflowMenus();syncAdminWorkflowSelects();
  };
  field.onchange=sync;sync();
};

function adminSelectedWorkflowOptions(){
  return {displayName:$('#adminWorkflowDisplayName').value.trim(),...Object.fromEntries(['ERF','ECF'].map(form=>[form,{
    review:document.querySelector(`[data-workflow-review="${form}"]`).value,
    check:form==='ECF'?$('#adminWorkflowCheck').value:'PRIMARY',
    bypass:document.querySelector(`[data-workflow-bypass="${form}"]`).checked
  }]))};
}
