// ECF admin access extension.
// Loaded after /app.js so the stable ERF user-management flow can be extended
// without changing the existing ERF Access semantics.

let ecfAdminRoles=[];

function ecfRoleLabel(role){
  const value=String(role||'NONE').toUpperCase();
  if(value==='CHECKER') return 'Checker';
  if(value==='REQUESTOR') return 'Requestor';
  if(value==='REVIEWER') return 'Reviewer';
  if(value==='APPROVER') return 'Approver';
  return 'No Access';
}

function ecfRoleClass(role){
  const value=String(role||'NONE').toUpperCase();
  return `ecf-access-${value.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`;
}

function ecfInjectAdminStyles(){
  if(document.getElementById('ecfAdminStyles')) return;
  const style=document.createElement('style');
  style.id='ecfAdminStyles';
  style.textContent=`
    .ecf-access-chip{
      display:inline-flex;align-items:center;justify-content:center;
      min-height:26px;padding:4px 9px;border-radius:999px;
      background:#eef4fb;color:#155da8;font-size:11px;font-weight:800;
      white-space:nowrap;
    }
    .ecf-access-checker{background:#fff4db;color:#8a5600}
    .ecf-access-reviewer,.ecf-access-approver{background:#eef7ef;color:#28633a}
    .ecf-access-none{background:#f2f4f7;color:#667085}
    .ecf-access-field select{
      width:100%;min-height:42px;padding:9px 11px;border:1px solid #d7dee8;
      border-radius:10px;background:#fff;color:#172033;font:inherit;
    }
    .ecf-access-field select:disabled{background:#f8fafc;color:#667085;cursor:not-allowed}
    .ecf-access-field small{display:block;margin-top:5px;line-height:1.4}
    .ecf-access-inherited{
      display:flex;align-items:center;min-height:42px;padding:9px 11px;
      border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;
      color:#475467;font-size:13px;font-weight:700;
    }
  `;
  document.head.appendChild(style);
}

function ecfApplyErfAccessLabels(){
  const roleHeader=document.querySelector('#adminUsersTable thead tr')?.children?.[4];
  if(roleHeader) roleHeader.textContent='ERF Access';

  const roleFieldLabel=document.querySelector('#adminUserForm .admin-role-field > label');
  if(roleFieldLabel) roleFieldLabel.textContent='ERF Access';
}

function ecfMergeRoleSnapshot(users,roles){
  const byEmail=new Map((roles||[]).map(r=>[String(r.email||'').toLowerCase(),r]));
  return (users||[]).map(user=>{
    const role=byEmail.get(String(user.email||'').toLowerCase());
    const primary=String(user.role||'').toUpperCase();
    return {
      ...user,
      ecf_role:role?.ecfRole || (primary==='REVIEWER'?'REVIEWER':primary==='APPROVER'?'APPROVER':primary==='REQUESTOR'?'NONE':'NONE'),
      ecf_role_inherited:role?.ecfRoleInherited ?? ['REVIEWER','APPROVER'].includes(primary)
    };
  });
}

loadAdminUsers=async function(){
  if(currentEmployee?.role!=='ADMIN') return;
  try{
    const [usersData,settingsData]=await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/app-settings')
    ]);
    ecfAdminRoles=settingsData?.settings?.ecfRoles||[];
    adminUsers=ecfMergeRoleSnapshot(usersData.users||[],ecfAdminRoles);
    renderAdminUsers();
  }catch(e){
    msg(e.message,'err');
  }
};

const ecfOriginalRenderAdminUsers=renderAdminUsers;
renderAdminUsers=function(){
  ecfInjectAdminStyles();
  ecfOriginalRenderAdminUsers();
  ecfApplyErfAccessLabels();

  const headerRow=document.querySelector('#adminUsersTable thead tr');
  if(headerRow && !document.getElementById('adminEcfAccessHeader')){
    const th=document.createElement('th');
    th.id='adminEcfAccessHeader';
    th.textContent='ECF Access';
    const erfAccessHeader=headerRow.children[4];
    erfAccessHeader?.insertAdjacentElement('afterend',th);
  }

  document.querySelectorAll('#adminUsersBody tr').forEach((row,index)=>{
    const user=adminUsers[index];
    if(!user) return;
    const erfAccessCell=row.children[4];
    if(!erfAccessCell) return;
    const td=document.createElement('td');
    const role=String(user.ecf_role||'NONE').toUpperCase();
    td.innerHTML=`<span class="ecf-access-chip ${ecfRoleClass(role)}">${esc(ecfRoleLabel(role))}</span>`;
    erfAccessCell.insertAdjacentElement('afterend',td);
  });
};

function ecfEnsureAccessField(){
  ecfInjectAdminStyles();
  ecfApplyErfAccessLabels();
  let field=document.getElementById('adminEcfAccessField');
  if(field) return field;

  const erfAccessField=document.querySelector('#adminUserForm .admin-role-field');
  if(!erfAccessField) return null;

  field=document.createElement('div');
  field.id='adminEcfAccessField';
  field.className='field ecf-access-field';
  field.innerHTML=`
    <label>ECF Access</label>
    <select id="adminEcfAccess">
      <option value="REQUESTOR">Requestor</option>
      <option value="CHECKER">Checker</option>
      <option value="NONE">No Access</option>
    </select>
    <div id="adminEcfInherited" class="ecf-access-inherited hidden"></div>
    <small id="adminEcfAccessHint" class="muted">Expense Claim Form access. ERF Access remains unchanged.</small>`;
  erfAccessField.insertAdjacentElement('afterend',field);
  return field;
}

function ecfCurrentEditingUser(){
  return editingAdminEmail
    ? adminUsers.find(u=>String(u.email).toLowerCase()===String(editingAdminEmail).toLowerCase())
    : null;
}

function ecfSyncAccessField({preserve=false}={}){
  const field=ecfEnsureAccessField();
  if(!field) return;

  const select=document.getElementById('adminEcfAccess');
  const inherited=document.getElementById('adminEcfInherited');
  const hint=document.getElementById('adminEcfAccessHint');
  const primary=String(document.getElementById('adminRole')?.value||'REQUESTOR').toUpperCase();
  const active=document.getElementById('adminActiveField')?.classList.contains('hidden')
    ? true
    : Boolean(document.getElementById('adminActive')?.checked);
  const user=ecfCurrentEditingUser();

  if(primary==='REVIEWER' || primary==='APPROVER'){
    select.classList.add('hidden');
    inherited.classList.remove('hidden');
    inherited.textContent=`${ecfRoleLabel(primary)} — inherited from ERF Access`;
    hint.textContent='ECF Access follows ERF Access automatically for Reviewer and Approver.';
    return;
  }

  inherited.classList.add('hidden');
  select.classList.remove('hidden');
  select.disabled=!active;

  if(!active){
    select.value='NONE';
    hint.textContent='Inactive users do not have active ECF Access.';
    return;
  }

  if(!preserve){
    const current=user && user.role==='REQUESTOR'
      ? String(user.ecf_role||'REQUESTOR').toUpperCase()
      : 'REQUESTOR';
    select.value=['REQUESTOR','CHECKER','NONE'].includes(current)?current:'REQUESTOR';
  }
  hint.textContent='Requestor, Checker, or No Access applies only to ECF. ERF Access stays unchanged.';
}

const ecfOriginalSelectAdminRole=selectAdminRole;
selectAdminRole=function(value,label){
  ecfOriginalSelectAdminRole(value,label);
  ecfSyncAccessField({preserve:false});
};

const ecfOriginalOpenAdminUserModal=openAdminUserModal;
openAdminUserModal=function(encodedEmail=''){
  const result=ecfOriginalOpenAdminUserModal(encodedEmail);
  ecfApplyErfAccessLabels();
  ecfEnsureAccessField();
  ecfSyncAccessField({preserve:false});
  return result;
};

document.addEventListener('change',event=>{
  if(event.target?.id==='adminActive') ecfSyncAccessField({preserve:true});
});

function ecfSelectedRole(){
  const primary=String(document.getElementById('adminRole')?.value||'REQUESTOR').toUpperCase();
  if(primary==='REVIEWER') return 'REVIEWER';
  if(primary==='APPROVER') return 'APPROVER';
  return String(document.getElementById('adminEcfAccess')?.value||'REQUESTOR').toUpperCase();
}

function ecfActiveChecker(excludeEmail=''){
  const exclude=String(excludeEmail||'').toLowerCase();
  return adminUsers.find(user=>
    user.active &&
    String(user.ecf_role||'').toUpperCase()==='CHECKER' &&
    String(user.email||'').toLowerCase()!==exclude
  )||null;
}

async function ecfSaveRoleAssignment(email,role,replaceChecker=false){
  return api('/api/admin/app-settings',{
    method:'PUT',
    body:JSON.stringify({
      ecfRoleAssignment:{email,role,replaceChecker:Boolean(replaceChecker)}
    })
  });
}

saveAdminUser=async function(event){
  event.preventDefault();
  if(currentEmployee?.role!=='ADMIN') return;

  const originalEmail=editingAdminEmail;
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
    active:originalEmail?$('#adminActive').checked:true
  };

  const selectedEcfRole=ecfSelectedRole();
  const targetEmail=originalEmail||body.email;
  let replaceChecker=false;

  if(body.role==='REQUESTOR' && body.active && selectedEcfRole==='CHECKER'){
    const checker=ecfActiveChecker(targetEmail);
    if(checker){
      const confirmed=window.confirm(
        `Replace ECF Checker?\n\nCurrent ECF Checker: ${checker.name}\n\nOnly one active Checker can be assigned.`
      );
      if(!confirmed) return;
      replaceChecker=true;
    }
  }

  const btn=$('#saveAdminUserBtn');
  btn.disabled=true;
  btn.textContent=originalEmail?'Saving…':'Creating…';

  try{
    if(originalEmail){
      await api(`/api/admin/users/${encodeURIComponent(originalEmail)}`,{
        method:'PUT',body:JSON.stringify(body)
      });
    }else{
      await api('/api/admin/users',{method:'POST',body:JSON.stringify(body)});
    }

    if(body.role==='REQUESTOR' && body.active){
      await ecfSaveRoleAssignment(targetEmail,selectedEcfRole,replaceChecker);
    }

    closeAdminUserModal();
    msg(originalEmail?'User updated successfully.':'User created successfully.','ok');
    await loadAdminUsers();
  }catch(e){
    msg(e.message,'err');
    await loadAdminUsers().catch(()=>{});
  }finally{
    btn.disabled=false;
    btn.textContent=originalEmail?'Save Changes':'Create User';
  }
};
