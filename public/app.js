const $=s=>document.querySelector(s);
const rupiah=n=>'Rp'+Number(n||0).toLocaleString('id-ID');
function msg(text,type='ok'){ $('#msg').innerHTML=`<div class="notice ${type}">${text}</div>`; }
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function api(url,opt={}){
  const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});
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
    $('#loginCard').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    $('#userBadge').textContent=`${employee.name} · ${employee.role}`;
    $('#roleTitle').textContent=employee.role==='REQUESTOR'?'Requestor Dashboard':employee.role==='REVIEWER'?'Reviewer Dashboard':'Approver Dashboard';
    $('#queueTitle').textContent=employee.role==='REQUESTOR'?'My Requests':employee.role==='REVIEWER'?'Pending Review':'Pending Approval';
    $('#identity').textContent=employee.email;
    const fields=[['Employee ID',employee.employee_id],['Department',employee.department],['Location',employee.location],['Division',employee.division],['Role',employee.role]];
    $('#profile').innerHTML=fields.map(([a,b])=>`<div><label>${a}</label><strong>${esc(b)}</strong></div>`).join('');
    if(requests.length){
      $('#empty').classList.add('hidden'); $('#table').classList.remove('hidden');
      $('#tbody').innerHTML=requests.map(r=>`<tr><td>${esc(r.ref_no)}</td><td>${esc(r.employee_name)}</td><td>${String(r.request_date).slice(0,10)}</td><td>${rupiah(r.total)}</td><td><span class="status">${esc(r.status)}</span></td><td>${r.revision}</td></tr>`).join('');
    }else{
      $('#empty').classList.remove('hidden'); $('#table').classList.add('hidden');
    }
  }catch(e){
    $('#loginCard').classList.remove('hidden'); $('#dashboard').classList.add('hidden');
    await loadUsers();
  }
}

async function logout(){
  await api('/api/logout',{method:'POST',body:'{}'});
  $('#dashboard').classList.add('hidden');
  $('#loginCard').classList.remove('hidden');
  $('#userBadge').textContent='Not signed in';
  await loadUsers();
}
loadMe();