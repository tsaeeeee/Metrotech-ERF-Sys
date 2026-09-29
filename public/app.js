const $=s=>document.querySelector(s);
const rupiah=n=>'Rp'+Number(n||0).toLocaleString('id-ID');
let currentEmployee=null;
let payments=[];
let editingIndex=-1;
let revisionTarget=null;
let currentDetailId=null;
let adminUsers=[];
let editingAdminEmail=null;
let appSettingsLoaded=false;

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

async function loadAuthMode(){
  try{
    const mode=await api('/api/auth-mode');
    $('#loginForm').classList.toggle('hidden',!mode.localLoginEnabled);
    $('#googleLoginWrap').classList.toggle('hidden',!mode.googleAuthReady);
  }catch{
    $('#loginForm').classList.remove('hidden');
    $('#googleLoginWrap').classList.add('hidden');
  }
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

function employeeNeedsSetup(employee=currentEmployee){
  return Boolean(
    employee &&
    employee.role!=='ADMIN' &&
    (employee.must_change_password || employee.must_upload_signature)
  );
}

function renderFirstSetupState(){
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  const passwordDone=!currentEmployee.must_change_password;
  const signatureDone=!currentEmployee.must_upload_signature;

  $('#firstPasswordState').className=`setup-state ${passwordDone?'done':'pending'}`;
  $('#firstPasswordState').innerHTML=passwordDone
    ? '<strong>✓ Password</strong><span>Changed</span>'
    : '<strong>1 Password</strong><span>Change required</span>';

  $('#firstSignatureState').className=`setup-state ${signatureDone?'done':'pending'}`;
  $('#firstSignatureState').innerHTML=signatureDone
    ? '<strong>✓ Signature</strong><span>Uploaded</span>'
    : '<strong>2 Signature</strong><span>Upload required</span>';

  $('#firstPasswordForm').classList.toggle('hidden',passwordDone);
  $('#firstSignatureForm').classList.toggle('hidden',signatureDone);
}

function openFirstSetupModal(){
  renderFirstSetupState();
  $('#firstSetupModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeFirstSetupModal(force=false){
  if(!force && employeeNeedsSetup()) return;
  $('#firstSetupModal')?.classList.add('hidden');
  $('#firstCurrentPassword').value='';
  $('#firstNewPassword').value='';
  $('#firstConfirmPassword').value='';
  $('#firstSetupSignature').value='';
  $('#firstSetupSignatureInfo').textContent='No file selected';
  if($('#profileModal').classList.contains('hidden') && $('#detailModal').classList.contains('hidden') && $('#adminUserModal').classList.contains('hidden'))
    document.body.classList.remove('modal-open');
}

async function finishFirstSetupIfReady(){
  if(employeeNeedsSetup()){
    renderFirstSetupState();
    return;
  }
  closeFirstSetupModal(true);
  await loadMe();
  msg('Account setup completed successfully.','ok');
}

async function submitFirstPassword(event){
  event.preventDefault();
  const currentPassword=$('#firstCurrentPassword').value;
  const newPassword=$('#firstNewPassword').value;
  const confirmPassword=$('#firstConfirmPassword').value;
  if(newPassword!==confirmPassword) return msg('New password confirmation does not match.','err');

  const btn=$('#firstPasswordBtn');
  btn.disabled=true;
  btn.textContent='Changing…';
  try{
    const result=await api('/api/profile/password',{
      method:'PUT',
      body:JSON.stringify({currentPassword,newPassword,confirmPassword})
    });
    currentEmployee=result.employee;
    $('#firstCurrentPassword').value='';
    $('#firstNewPassword').value='';
    $('#firstConfirmPassword').value='';
    msg('Password changed successfully.','ok');
    await finishFirstSetupIfReady();
  }catch(e){
    msg(e.message,'err');
  }finally{
    btn.disabled=false;
    btn.textContent='Change Password';
  }
}

async function submitFirstSignature(event){
  event.preventDefault();
  const sig=$('#firstSetupSignature').files?.[0];
  if(!sig) return msg('Choose a signature image first.','err');

  const btn=$('#firstSignatureBtn');
  btn.disabled=true;
  btn.textContent='Uploading…';
  try{
    const fd=new FormData();
    fd.append('signature',sig,sig.name);
    const result=await api('/api/profile',{method:'PUT',body:fd});
    currentEmployee=result.employee;
    $('#firstSetupSignature').value='';
    $('#firstSetupSignatureInfo').textContent='No file selected';
    msg('Digital signature uploaded successfully.','ok');
    await finishFirstSetupIfReady();
  }catch(e){
    msg(e.message,'err');
  }finally{
    btn.disabled=false;
    btn.textContent='Upload Signature';
  }
}

async function loadMe(){
  try{
    const {employee,requests,tasks,myRequests,history=[]}=await api('/api/me');
    window.emsBootstrap={requests,tasks,myRequests,history};
    currentEmployee=employee;
    $('#loginCard').classList.add('hidden');
    $('#dashboard').classList.add('hidden');

    const initials=String(employee.name||employee.email||'U')
      .split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase();
    $('#userAvatar').textContent=initials||'U';
    $('#userMenuName').textContent=employee.name||employee.email;
    $('#userMenuRole').textContent=employee.role==='NONE'
      ? employee.ecfRole==='NONE'?'No Access':`ECF ${employee.ecfRole==='CHECKER'?'Checker':'Requestor'}`
      : employee.role;
    $('#userMenuFullName').textContent=employee.name||employee.email;
    $('#userMenuEmail').textContent=employee.email;

    if(employeeNeedsSetup(employee)){
      $('#userMenuWrap').classList.add('hidden');
      openFirstSetupModal();
      return;
    }

    closeFirstSetupModal(true);
    $('#dashboard').classList.remove('hidden');
    $('#userMenuWrap').classList.remove('hidden');

    const isAdmin=employee.role==='ADMIN';
    $('#workflowDashboard').classList.toggle('hidden',isAdmin);
    $('#adminDashboard').classList.toggle('hidden',!isAdmin);
    $('#userProfileMenuItem').classList.toggle('hidden',isAdmin);

    if(isAdmin){
      showAdminSection('users',false);
      await loadAdminUsers();
      return;
    }

    $('#roleTitle').textContent=employee.role==='REQUESTOR'?'Requestor Dashboard':employee.role==='REVIEWER'?'Reviewer Dashboard':employee.role==='APPROVER'?'Approver Dashboard':'Checker Dashboard';
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

function renderRequests(requests,tableId='table',bodyId='tbody',emptyId='empty'){
  if(!requests.length){
    $(`#${emptyId}`).classList.remove('hidden');
    $(`#${tableId}`).classList.add('hidden');
    return;
  }
  $(`#${emptyId}`).classList.add('hidden');
  $(`#${tableId}`).classList.remove('hidden');
  $(`#${bodyId}`).innerHTML=requests.map(r=>{
    const ownRequest=(r.form_type==='ECF'
      ? currentEmployee?.ecfRole==='REQUESTOR'
      : currentEmployee?.role==='REQUESTOR') &&
      String(r.requester_email||'').toLowerCase()===String(currentEmployee.email).toLowerCase();
    const revisable=['CHECK_REJECTED','REVIEW_REJECTED','APPROVAL_REJECTED','RECALLED'].includes(r.status);
    const revise=ownRequest && revisable
      ? `<button class="btn tiny warning" onclick="startRevision('${r.id}')">${r.status==='RECALLED'?'Edit & Resubmit':'Revise'}</button>`
      : '';
    const recall=ownRequest &&
      r.status===(r.form_type==='ECF'?'PENDING_CHECK':'PENDING_REVIEW')
      ? `<button class="btn tiny recall" onclick="recallRequest('${r.id}','${esc(r.ref_no)}','${r.form_type==='ECF'?'ECF':'ERF'}')">Recall</button>`
      : '';
    const canRecallDecision=(currentEmployee?.role==='APPROVER' && r.status==='APPROVED' &&
      String(r.approver_email).toLowerCase()===String(currentEmployee.email).toLowerCase()) ||
      (currentEmployee?.role==='REVIEWER' && r.status==='PENDING_APPROVAL' &&
      String(r.reviewer_email).toLowerCase()===String(currentEmployee.email).toLowerCase());
    const approvalRecall=canRecallDecision && (r.form_type!=='ECF' || currentEmployee.role==='APPROVER')
      ? `<button class="btn tiny danger" data-form-type="${r.form_type==='ECF'?'ECF':'ERF'}" onclick="openApprovalRecall('${r.id}',this)">Recall</button>` : '';
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
      <td class="actions action-col"><button class="btn tiny ghost" onclick="openRequest('${r.id}')">Open</button> ${savePdf} ${approvalRecall} ${recall} ${revise}</td>
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
    ['Role',currentEmployee.role==='NONE'
      ? `ERF: No Access · ECF: ${currentEmployee.ecfRole==='CHECKER'?'Checker':currentEmployee.ecfRole==='REQUESTOR'?'Requestor':'No Access'}`
      : currentEmployee.role]
  ];
  $('#lockedProfileGrid').innerHTML=fields.map(([label,value])=>`
    <div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
  `).join('');
  $('#profileSignature').value='';
  $('#profileSignatureInfo').textContent='No file selected';
  $('#profileCurrentPassword').value='';
  $('#profileNewPassword').value='';
  $('#profileConfirmPassword').value='';
  $('#profileModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeProfileModal(){
  $('#profileModal').classList.add('hidden');
  $('#profileSignature').value='';
  $('#profileSignatureInfo').textContent='No file selected';
  $('#profileCurrentPassword').value='';
  $('#profileNewPassword').value='';
  $('#profileConfirmPassword').value='';
  if($('#detailModal').classList.contains('hidden') && $('#adminUserModal').classList.contains('hidden') && $('#firstSetupModal').classList.contains('hidden'))
    document.body.classList.remove('modal-open');
}

function profileBackdrop(e){
  if(e.target.id==='profileModal') closeProfileModal();
}

async function changeProfilePassword(event){
  event.preventDefault();
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;

  const currentPassword=$('#profileCurrentPassword').value;
  const newPassword=$('#profileNewPassword').value;
  const confirmPassword=$('#profileConfirmPassword').value;
  if(newPassword!==confirmPassword) return msg('New password confirmation does not match.','err');

  const btn=$('#changeProfilePasswordBtn');
  btn.disabled=true;
  btn.textContent='Changing…';
  try{
    const result=await api('/api/profile/password',{
      method:'PUT',
      body:JSON.stringify({currentPassword,newPassword,confirmPassword})
    });
    currentEmployee=result.employee;
    $('#profileCurrentPassword').value='';
    $('#profileNewPassword').value='';
    $('#profileConfirmPassword').value='';
    msg('Password changed successfully.','ok');
  }catch(e){
    msg(e.message,'err');
  }finally{
    btn.disabled=false;
    btn.textContent='Change Password';
  }
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

function showAdminSection(section,load=true){
  if(currentEmployee?.role!=='ADMIN') return;
  const app=section==='app';
  $('#adminUserManagementView').classList.toggle('hidden',app);
  $('#adminAppManagementView').classList.toggle('hidden',!app);
  $('#adminUsersTab').classList.toggle('active',!app);
  $('#adminAppTab').classList.toggle('active',app);
  if(app && load && !appSettingsLoaded) loadAppSettings();
}

function readinessItem(ok,label,detail=''){
  return `<div class="readiness-item ${ok?'ready':'pending'}">
    <span class="readiness-dot">${ok?'✓':'!'}</span>
    <div><strong>${esc(label)}</strong>${detail?`<small>${esc(detail)}</small>`:''}</div>
  </div>`;
}

function renderAppReadiness(data){
  const r=data.readiness||{};
  const items=[
    [r.database,'Database','Connected'],
    [r.storage,'Persistent Storage',r.storage?'/data/pdfs available':'Storage unavailable'],
    [r.reviewer,'Reviewer',`${r.reviewerCount||0} active`],
    [r.approver,'Approver',`${r.approverCount||0} active — exactly 1 required`],
    [r.smtp,'SMTP',r.smtp?'Enabled and configured':'Enable and complete SMTP'],
    [r.authentication,'Authentication',r.authentication?'Login path available':'Authentication incomplete'],
    [r.https,'App URL / HTTPS',r.https?'HTTPS URL configured':'Production HTTPS URL required'],
    [r.secureCookie,'Secure Cookie',r.secureCookie?'HTTPS-only cookie enabled':'Enable for production HTTPS'],
    [r.sessionSecret,'Session Secret',r.sessionSecret?'Generated and stored':'Session secret missing'],
    [r.masterKeyExternal,'Config Master Key',r.masterKeyExternal?'External key configured':'Using development fallback']
  ];
  const ready=items.filter(x=>x[0]).length;
  $('#appReadinessScore').textContent=`${ready} / ${items.length} Ready`;
  $('#appReadinessScore').classList.toggle('ready',ready===items.length);
  $('#appReadinessGrid').innerHTML=items.map(x=>readinessItem(...x)).join('');
  $('#appRestartNotice').classList.toggle('hidden',!data.restartRequired);
}

function populateAppSettings(data){
  const s=data.settings||{};
  $('#appBaseUrl').value=s.appBaseUrl||'';
  $('#appTimezone').value=s.timezone||'Asia/Jakarta';
  $('#appLocalLogin').checked=Boolean(s.localLoginEnabled);
  $('#appGoogleEnabled').checked=Boolean(s.googleEnabled);
  $('#appGoogleDomain').value=s.allowedGoogleDomain||'metrotech.id';
  $('#appGoogleClientId').value=s.googleClientId||'';
  $('#appGoogleClientSecret').value='';
  $('#appGoogleCallbackUrl').value=s.googleCallbackUrl||'';
  $('#appGoogleSecretState').textContent=s.googleClientSecretConfigured
    ? 'Configured — leave blank to keep current secret.'
    : 'Not configured';

  $('#appSmtpEnabled').checked=Boolean(s.smtpEnabled);
  $('#appSmtpSecure').checked=Boolean(s.smtpSecure);
  $('#appSmtpHost').value=s.smtpHost||'';
  $('#appSmtpPort').value=s.smtpPort||587;
  $('#appSmtpUser').value=s.smtpUser||'';
  $('#appSmtpPassword').value='';
  $('#appSmtpPasswordState').textContent=s.smtpPasswordConfigured
    ? 'Configured — leave blank to keep current password.'
    : 'Not configured';
  $('#appMailSenderName').value=s.mailSenderName||'Metrotech Expense Approval System';
  $('#appMailFrom').value=s.mailFrom||'no-reply@metrotech.id';
  $('#appMailOverrideTo').value=s.mailOverrideTo||'';
  $('#appFinalApprovedCc').value=s.finalApprovedCc||'';

  $('#appSessionHours').value=s.sessionHours||8;
  $('#appLoginRateLimit').value=s.loginRateLimit||10;
  $('#appCookieSecure').checked=Boolean(s.cookieSecure);
  $('#appSessionSecretState').textContent=s.sessionSecretConfigured
    ? 'Managed automatically'
    : 'Not configured';

  renderAppReadiness(data);
}

async function loadAppSettings(){
  if(currentEmployee?.role!=='ADMIN') return;
  try{
    const data=await api('/api/admin/app-settings');
    populateAppSettings(data);
    appSettingsLoaded=true;
  }catch(e){
    msg(e.message,'err');
  }
}

function collectAppSettings(){
  return {
    appBaseUrl:$('#appBaseUrl').value.trim(),
    timezone:$('#appTimezone').value.trim(),
    localLoginEnabled:$('#appLocalLogin').checked,
    googleEnabled:$('#appGoogleEnabled').checked,
    allowedGoogleDomain:$('#appGoogleDomain').value.trim(),
    googleClientId:$('#appGoogleClientId').value.trim(),
    googleClientSecret:$('#appGoogleClientSecret').value,
    googleCallbackUrl:$('#appGoogleCallbackUrl').value.trim(),
    smtpEnabled:$('#appSmtpEnabled').checked,
    smtpSecure:$('#appSmtpSecure').checked,
    smtpHost:$('#appSmtpHost').value.trim(),
    smtpPort:Number($('#appSmtpPort').value||587),
    smtpUser:$('#appSmtpUser').value.trim(),
    smtpPassword:$('#appSmtpPassword').value,
    mailSenderName:$('#appMailSenderName').value.trim(),
    mailFrom:$('#appMailFrom').value.trim(),
    mailOverrideTo:$('#appMailOverrideTo').value.trim(),
    finalApprovedCc:$('#appFinalApprovedCc').value.trim(),
    sessionHours:Number($('#appSessionHours').value||8),
    loginRateLimit:Number($('#appLoginRateLimit').value||10),
    cookieSecure:$('#appCookieSecure').checked
  };
}

async function saveAppManagement(event,{silent=false}={}){
  event?.preventDefault();
  if(currentEmployee?.role!=='ADMIN') return false;
  const btn=$('#saveAppSettingsBtn');
  btn.disabled=true;
  btn.textContent='Saving…';
  try{
    const data=await api('/api/admin/app-settings',{
      method:'PUT',
      body:JSON.stringify(collectAppSettings())
    });
    populateAppSettings(data);
    appSettingsLoaded=true;
    await loadAuthMode();
    if(!silent) msg('Application settings saved successfully.','ok');
    return true;
  }catch(e){
    msg(e.message,'err');
    return false;
  }finally{
    btn.disabled=false;
    btn.textContent='Save Settings';
  }
}

async function testAppSmtp(){
  if(currentEmployee?.role!=='ADMIN') return;
  const saved=await saveAppManagement(null,{silent:true});
  if(!saved) return;
  const suggested=$('#appMailOverrideTo').value.trim()||currentEmployee.email||'';
  const to=window.prompt('Send SMTP test email to:',suggested);
  if(!to) return;
  try{
    const result=await api('/api/admin/app-settings/test-smtp',{
      method:'POST',
      body:JSON.stringify({to:to.trim()})
    });
    msg(result.message||'SMTP test email sent.','ok');
  }catch(e){
    msg(e.message,'err');
  }
}

async function rotateAppSessionSecret(){
  if(currentEmployee?.role!=='ADMIN') return;
  if(!window.confirm('Rotate the session secret? All users will be signed out after the application restarts.')) return;
  try{
    const data=await api('/api/admin/app-settings/rotate-session',{method:'POST',body:'{}'});
    populateAppSettings(data);
    msg('Session secret rotated. Restart the app container to apply it.','ok');
  }catch(e){
    msg(e.message,'err');
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
  $('#adminUsersBody').innerHTML=adminUsers.map(u=>{
    const stateAction=u.active
      ? `<button class="btn tiny danger" type="button" onclick="setAdminUserActive('${encodeURIComponent(u.email)}',false)">Remove</button>`
      : `<button class="btn tiny success" type="button" onclick="setAdminUserActive('${encodeURIComponent(u.email)}',true)">Restore</button>`;
    return `
    <tr class="${u.active?'':'inactive-user-row'}">
      <td><strong>${esc(u.name)}</strong><div class="admin-username">@${esc(u.username||'—')}</div></td>
      <td>${esc(u.email)}</td>
      <td>${esc(u.employee_id)}</td>
      <td>${esc(u.department)}</td>
      <td><span class="role-chip">${esc(u.role==='NONE'?'No Access':u.role)}</span></td>
      <td>${u.has_signature?'<span class="signature-state ready">Uploaded</span>':'<span class="signature-state">Not uploaded</span>'}</td>
      <td>${u.must_change_password && u.must_upload_signature
        ? '<span class="signature-state">Password & signature required</span>'
        : u.must_change_password
          ? '<span class="signature-state">Password change required</span>'
          : u.must_upload_signature
            ? '<span class="signature-state">Signature upload required</span>'
            : '<span class="signature-state ready">Ready</span>'}</td>
      <td>${u.active?'<span class="user-state active">Active</span>':'<span class="user-state">Inactive</span>'}</td>
      <td class="actions action-col">
        <button class="btn tiny ghost" type="button" onclick="openAdminUserModal('${encodeURIComponent(u.email)}')">Edit</button>
        ${stateAction}
      </td>
    </tr>`;
  }).join('');
}

async function setAdminUserActive(encodedEmail,active){
  if(currentEmployee?.role!=='ADMIN') return;
  const email=decodeURIComponent(encodedEmail);
  const user=adminUsers.find(u=>u.email===email);
  if(!user) return;

  const verb=active?'restore':'remove';
  const promptText=active
    ? `Restore ${user.name}? This user will be able to sign in again.`
    : `Remove ${user.name}? The account will be deactivated, but request and approval history will be preserved.`;

  if(!window.confirm(promptText)) return;

  try{
    await api(`/api/admin/users/${encodeURIComponent(email)}/status`,{
      method:'PATCH',
      body:JSON.stringify({active})
    });
    msg(`${user.name} ${active?'restored':'removed'} successfully.`,'ok');
    await loadAdminUsers();
  }catch(e){
    msg(e.message,'err');
  }
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
  const roleLabel=roleValue==='REVIEWER'?'Reviewer':roleValue==='APPROVER'?'Approver':roleValue==='NONE'?'No Access':'Requestor';
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
  $('#categoryButton').title=value;
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
  $('#categoryButton').removeAttribute('title');
  $('#categoryLabel').classList.add('custom-select-placeholder');
  document.querySelectorAll('#categoryMenu button').forEach(btn=>btn.classList.remove('selected'));
  closeCategoryMenu();
}

document.addEventListener('click',e=>{
  const custom=$('#categorySelect');
  if(custom && !custom.contains(e.target)) closeCategoryMenu();
});

function selectedFiles(){ return Array.from($('#evidence').files||[]); }

function editingPaymentEvidence(){
  return editingIndex>=0 ? (payments[editingIndex]?.evidence||[]) : [];
}

function syncAddButton(){
  const hasEvidence=selectedFiles().length>0 || editingPaymentEvidence().length>0;
  const valid=$('#category').value.trim() && $('#purpose').value.trim() && $('#paymentDate').value &&
    Number($('#amount').value)>0 && hasEvidence;
  $('#addPaymentBtn').disabled=!valid;
}

function syncEvidenceInfo(){
  const files=selectedFiles();
  if(files.length){
    $('#evidenceInfo').textContent=editingIndex>=0
      ? `New evidence: ${files.map(f=>f.name).join(', ')} — replaces the current evidence.`
      : `${files.length} file(s): ${files.map(f=>f.name).join(', ')}`;
  }else if(editingIndex>=0 && editingPaymentEvidence().length){
    $('#evidenceInfo').textContent=
      `Keeping current evidence: ${editingPaymentEvidence().map(f=>f.name).join(', ')}. Choose new file(s) only to replace it.`;
  }else{
    $('#evidenceInfo').textContent='No file selected';
  }
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
  if(e.target.id==='firstSetupSignature'){
    const file=e.target.files?.[0];
    $('#firstSetupSignatureInfo').textContent=file?file.name:'No file selected';
  }
});

function addPayment(){
  clearMsg();
  const files=selectedFiles();
  const previous=editingIndex>=0 ? payments[editingIndex] : null;
  const evidence=files.length ? files : (previous?.evidence||[]);
  const x={
    category:$('#category').value.trim(),
    purpose:$('#purpose').value.trim(),
    paymentDate:$('#paymentDate').value,
    amount:Math.round(Number($('#amount').value)),
    evidence,
    sourceLineNo:previous?.sourceLineNo||null
  };
  if(!x.category||!x.purpose||!x.paymentDate||!x.amount||!x.evidence.length)
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
  $('#addPaymentBtn').textContent='Update Payment';
  syncEvidenceInfo();
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

    revisionTarget={id,refNo,recalled,reason,formType:data.request.form_type||'ERF',missingEvidence:(data.items||[]).some(item=>item.evidenceReusable===false)};
    payments=(data.items||[]).map(item=>({
      category:String(item.category||''),
      purpose:String(item.purpose||''),
      paymentDate:String(item.payment_date||'').slice(0,10),
      amount:Number(item.amount||0),
      evidence:(item.evidenceReusable===false?[]:(item.evidence_names||[])).map(name=>({name:String(name),existing:true})),
      sourceLineNo:Number(item.line_no)
    }));
    editingIndex=-1;
    renderPayments();
    resetPaymentForm();

    renderRevisionState();
    $('#requestForm').scrollIntoView({behavior:'smooth'});
  }catch(e){msg(e.message,'err')}
}

async function recallRequest(id,refNo,formType='ERF'){
  const stage=formType==='ECF'?'Checker':'Reviewer';
  if(!confirm(`Recall ${refNo}? It will be removed from the ${stage} queue until you resubmit it.`)) return;
  try{
    const r=await api(`/api/requests/${id}/recall`,{method:'POST',body:'{}'});
    msg(`${r.refNo} recalled successfully. ${stage} can no longer action it until you resubmit.`,'ok');
    await loadMe();
  }catch(e){msg(e.message,'err')}
}

function renderRevisionState(){
  $('#revisionBanner').classList.toggle('hidden',!revisionTarget);
  $('#cancelRevisionBtn').classList.toggle('hidden',!revisionTarget);
  $('#requestFormTitle').textContent=revisionTarget
    ? `${revisionTarget.recalled?'Edit & Resubmit':'Revise'} ${revisionTarget.refNo}`
    : 'Create Expense Request';
  $('#submitExpenseBtn').textContent=revisionTarget?'Submit Revision':'Submit Expense';
  $('#revisionBanner').innerHTML=!revisionTarget?'':revisionTarget.recalled
    ? `<strong>Recalled:</strong> ${esc(revisionTarget.reason)} Edit the payment data below and resubmit for review.`
    : `<strong>Rejected:</strong> ${esc(revisionTarget.reason)} <span>Edit the existing payment data below and resubmit. Existing evidence is kept unless you replace it.</span>`;
  if(revisionTarget?.missingEvidence) $('#revisionBanner').innerHTML+=' <strong>Some original evidence is unavailable. Attach it again before resubmitting; the old approved packet remains in the audit trail.</strong>';
}

let approvalRecallTarget=null;
let approvalRecallTrigger=null;
let approvalRecallBusy=false;

function openApprovalRecall(id,trigger){
  if(!['APPROVER','REVIEWER'].includes(currentEmployee?.role)||approvalRecallBusy) return;
  if(typeof sigRequireWorkflowSignature==='function'&&!sigRequireWorkflowSignature('recall this approval')) return;
  $('#approvalRecallDescription').textContent=currentEmployee.role==='REVIEWER'
    ? 'Withdraw your review and return this request to the Requestor for revision. It will leave the Approver queue and require a new review and approval.'
    : trigger?.dataset.formType==='ECF'
      ? 'Return this claim to the Requestor for revision. It must pass Checker, Reviewer, and Approver again after resubmission. The previous approved PDF stays in the audit trail.'
      : 'Return this request to the Requestor for revision. It will require a new review and approval. The previous approved PDF stays in the audit trail.';
  approvalRecallTarget=id;
  approvalRecallTrigger=trigger;
  $('#approvalRecallTitle').textContent=`Recall ${trigger?.closest('tr')?.querySelector('td strong')?.textContent||'approval'}`;
  $('#approvalRecallReason').value='';
  $('#approvalRecallError').textContent='';
  $('#approvalRecallSubmit').disabled=true;
  $('#approvalRecallModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#approvalRecallReason').focus();
}

function closeApprovalRecall(){
  if(approvalRecallBusy) return;
  $('#approvalRecallModal').classList.add('hidden');
  approvalRecallTarget=null;
  if(!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
  approvalRecallTrigger?.focus();
  approvalRecallTrigger=null;
}

function approvalRecallKeydown(event){
  if(event.key==='Escape'){event.preventDefault();closeApprovalRecall();}
  if(event.key!=='Tab') return;
  const controls=[...$('#approvalRecallModal').querySelectorAll('button:not(:disabled),textarea:not(:disabled)')];
  const first=controls[0],last=controls[controls.length-1];
  if(!first){event.preventDefault();return;}
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}

async function submitApprovalRecall(event){
  event.preventDefault();
  if(!approvalRecallTarget||approvalRecallBusy) return;
  const reason=$('#approvalRecallReason').value.trim();
  if(!reason){$('#approvalRecallError').textContent='A recall reason is required.';return;}
  approvalRecallBusy=true;
  const button=$('#approvalRecallSubmit');
  button.disabled=true;
  button.textContent='Recalling…';
  $('#approvalRecallCancel').disabled=true;
  $('#approvalRecallReason').readOnly=true;
  $('#approvalRecallError').textContent='';
  try{
    const r=await api(`/api/requests/${approvalRecallTarget}/recall`,{method:'POST',body:JSON.stringify({reason})});
    approvalRecallBusy=false;
    closeApprovalRecall();
    await loadMe();
    msg(`${r.refNo}: ${currentEmployee.role==='REVIEWER'?'review':'approval'} recalled. Requestor can revise and resubmit.`,'ok');
  }catch(e){$('#approvalRecallError').textContent=e.message;}
  finally{
    approvalRecallBusy=false;
    button.disabled=!$('#approvalRecallReason').value.trim();
    button.textContent='Recall';
    $('#approvalRecallCancel').disabled=false;
    $('#approvalRecallReason').readOnly=false;
  }
}

function cancelRevision(){
  revisionTarget=null; payments=[]; editingIndex=-1; renderPayments(); resetPaymentForm();
  renderRevisionState();
}

async function submitExpense(){
  if(!payments.length) return;
  clearMsg();
  const btn=$('#submitExpenseBtn');
  btn.disabled=true; btn.textContent=revisionTarget?'Submitting Revision…':'Submitting…';
  try{
    const fd=new FormData();
    fd.append('items',JSON.stringify(payments.map(x=>({
      category:x.category,
      purpose:x.purpose,
      paymentDate:x.paymentDate,
      amount:x.amount,
      ...(x.sourceLineNo?{sourceLineNo:x.sourceLineNo}:{})
    }))));

    payments.forEach((x,i)=>{
      x.evidence
        .filter(file=>typeof File!=='undefined' && file instanceof File)
        .forEach(file=>fd.append(`evidence_${i}`,file,file.name));
    });

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

function renderDetailSummary(r){
  const assignee=key=>String(r[`${key}_name`]||'').trim()||String(r[`${key}_email`]||'').trim()||'—';
  const fields=[
    ['Request Date',String(r.request_date).slice(0,10)], ['Employee ID',r.employee_id],
    ['Department',r.department], ['Location',r.location],
    ['Division',r.division], ['Total',rupiah(r.total)],
    ['Reviewer',assignee('reviewer')], ['Approver',assignee('approver')]
  ];
  const rows=[];
  for(let i=0;i<fields.length;i+=2){
    rows.push(`<tr>${fields.slice(i,i+2).map(([label,value])=>`<th scope="row">${esc(label)}</th><td>${esc(value??'—')}</td>`).join('')}</tr>`);
  }
  $('#detailSummary').innerHTML=`<table class="detail-summary-table" aria-label="Request summary"><tbody>${rows.join('')}</tbody></table>`;
}

async function openRequest(id){
  clearMsg();
  try{
    const data=await api(`/api/requests/${id}`);
    currentDetailId=id;
    const r=data.request;
    $('#detailRef').textContent=r.ref_no;
    $('#detailMeta').textContent=`${r.employee_name} · Revision ${r.revision} · ${r.status}`;
    renderDetailSummary(r);

    $('#detailItems').innerHTML=data.items.map(it=>`<tr>
      <td>${it.line_no}</td><td>${esc(it.category)}</td><td>${esc(it.purpose)}</td>
      <td>${String(it.payment_date).slice(0,10)}</td>
      <td>${(it.evidence_names||[]).map(n=>`<span class="file-chip">📎 ${esc(n)}</span>`).join(' ')}</td>
      <td class="money">${rupiah(it.amount)}</td>
    </tr>`).join('');

    $('#auditTrail').innerHTML=data.actions.length?data.actions.map(a=>{
      const actorRole=['CHECK_APPROVED','CHECK_REJECTED'].includes(a.action)?'CHECKER':a.actor_role;
      return `
      <div class="audit-row">
        <div class="audit-dot"></div>
        <div><strong>${esc(a.action.replaceAll('_',' '))}</strong><span>${esc(a.actor_name)} · ${esc(actorRole)}</span>
        ${a.reason?`<p>${esc(a.reason)}</p>`:''}${a.action==='APPROVAL_RECALLED'?`<p><a href="/api/requests/${encodeURIComponent(id)}/approval-archive/${Number(a.revision)}">Previous approved PDF · revision ${Number(a.revision)} · superseded</a></p>`:''}<small>${new Date(a.created_at).toLocaleString('id-ID')}</small></div>
      </div>`;
    }).join(''):'<div class="muted">No audit entries.</div>';

    const stamp=Date.now();
    const formUrl=data.documents.form?`/api/requests/${id}/form?t=${stamp}`:null;
    const evidenceUrl=data.documents.evidence?`/api/requests/${id}/evidence?t=${stamp}`:null;

    const email=String(currentEmployee.email).toLowerCase();
    const actionable=(currentEmployee.role==='REVIEWER'&&r.status==='PENDING_REVIEW'&&String(r.reviewer_email).toLowerCase()===email) ||
      (currentEmployee.role==='APPROVER'&&r.status==='PENDING_APPROVAL'&&String(r.approver_email).toLowerCase()===email);
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
    return true;
  }catch(e){
    msg(e.message,'err');
    $('#approveBtn').disabled=false;
    syncRejectButton();
    return false;
  }
}

async function logout(){
  await api('/api/logout',{method:'POST',body:'{}'});
  clearMsg();
  currentEmployee=null; payments=[]; editingIndex=-1; revisionTarget=null; currentDetailId=null;
  adminUsers=[]; editingAdminEmail=null; appSettingsLoaded=false;
  $('#profileModal').classList.add('hidden');
  $('#firstSetupModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  renderPayments();
  $('#dashboard').classList.add('hidden');
  $('#loginCard').classList.remove('hidden');
  $('#userMenuWrap').classList.add('hidden');
  closeUserMenu();
  $('#loginPassword').value='';
  await loadAuthMode();
  setTimeout(()=>$('#loginUsername')?.focus(),0);
}

// EMS starts authentication after all UI extensions have been installed.
