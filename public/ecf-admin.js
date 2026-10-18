// Workflow access is saved atomically with the user's master data.
function adminSelectedWorkflowRoles(){
  return Object.fromEntries(Object.keys(FORM_ROLES).map(form=>[form,
    [...document.querySelectorAll(`#adminWorkflowRoles input[data-form="${form}"]:checked`)].map(input=>input.value)]));
}
function adminRoleText(user,form){
  return rolesFor({...user,active:true},form).map(role=>role[0]+role.slice(1).toLowerCase()).join(', ')||'No Access';
}
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
  }).join('')+`<small>Choose all required roles. Primary reviewers share one queue. Secondary executive roles require manual takeover. Only one active Approver is allowed across ERF and ECF.${assignedApprover?' Current Approver: '+esc(assignedApprover.name)+'.':''}</small>`;
  let optionsField=$('#adminWorkflowOptions');
  if(!optionsField){optionsField=document.createElement('div');optionsField.id='adminWorkflowOptions';optionsField.className='span-2 workflow-role-fields';field.insertAdjacentElement('afterend',optionsField)}
  const options=user?.workflow_options||{};
  optionsField.innerHTML=`<label>Workflow display name <span class="muted">(optional short name)</span><input id="adminWorkflowDisplayName" maxlength="40" value="${esc(options.displayName||'')}" placeholder="e.g. Dimas or Rizal"></label>`+['ERF','ECF'].map(form=>{
    const option=options[form]||{};
    return `<fieldset><legend>${form} Workflow</legend>
      <label>Reviewer assignment<select data-workflow-review="${form}">${[['ASSIGNED','Individual assignment'],['PRIMARY','Primary — shared queue'],['SECONDARY','Secondary — manual takeover']].map(([value,label])=>`<option value="${value}" ${value===(option.review||'ASSIGNED')?'selected':''}>${label}</option>`).join('')}</select></label>
      ${form==='ECF'?`<label>Checker assignment<select id="adminWorkflowCheck"><option value="PRIMARY">Primary</option><option value="SECONDARY" ${option.check==='SECONDARY'?'selected':''}>Secondary — manual takeover</option></select></label>`:''}
      <label><input type="checkbox" data-workflow-bypass="${form}" ${option.bypass?'checked':''}> Allow executive bypass on own requests</label>
      </fieldset>`;
  }).join('')+'<small>Secondary and bypass permissions require Approver access. Routing changes apply on submission or resubmission. Existing requests keep their assigned participants.</small>';
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
  };
  field.onchange=sync;sync();
  $('#adminUserModalHint').textContent='Manage user details and independent ERF / ECF access.';
};

function adminSelectedWorkflowOptions(){
  return {displayName:$('#adminWorkflowDisplayName').value.trim(),...Object.fromEntries(['ERF','ECF'].map(form=>[form,{
    review:document.querySelector(`[data-workflow-review="${form}"]`).value,
    check:form==='ECF'?$('#adminWorkflowCheck').value:'PRIMARY',
    bypass:document.querySelector(`[data-workflow-bypass="${form}"]`).checked
  }]))};
}
