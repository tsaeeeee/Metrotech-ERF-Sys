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
  }).join('')+`<small>Choose all required roles. Tasks remain assigned to a specific user. Only one active Approver is allowed across ERF and ECF.${assignedApprover?' Current Approver: '+esc(assignedApprover.name)+'.':''}</small>`;
  $('#adminUserModalHint').textContent='Manage user details and independent ERF / ECF access.';
};
