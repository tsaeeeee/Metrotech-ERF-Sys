let cashState={book:null,categories:[],offset:0,sequence:0,entries:[],preview:null};
const cashMoney=value=>'Rp'+Number(value||0).toLocaleString('id-ID',{minimumFractionDigits:2,maximumFractionDigits:2});
const cashSelect=(id,label,choices,value)=>adminWorkflowSelect(id,label,'',choices.map(([k,v])=>[esc(k),esc(v)]),esc(value??''));
const cashTime=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value))+' WIB':'—';
const cashAction=value=>({CREATED:'Entry created',VOIDED:'Entry voided',LEGACY_IMPORTED:'Legacy imported',BOOK_CREATED:'Book created'}[value]||value);
const cashBusy=async(button,label,fn)=>{if(button.disabled)return;const original=button.textContent;button.disabled=true;button.textContent=label;try{await fn()}catch(e){msg(e.message,'err')}finally{button.disabled=false;button.textContent=original}};

$('#emsNav [data-ems-view="home"]').insertAdjacentHTML('afterend','<button type="button" data-ems-view="cash" class="hidden" onclick="emsNavigate(\'cash\')">Cash Tracker</button>');
$('#emsAdminNav .ems-nav-items').insertAdjacentHTML('beforeend','<button type="button" data-ems-view="admin-cash" onclick="emsNavigate(\'admin-cash\')">Cash Settings</button>');
$('.ems-main').insertAdjacentHTML('beforeend',`<section id="cashView" class="hidden">
  <div class="cash-toolbar"><h2>Cash Tracker</h2><div id="cashBookPicker"></div><button class="btn primary" id="cashNew" onclick="cashEntryModal()">New Entry</button><button class="btn ghost" onclick="cashLog()">Log</button><button class="btn ghost" onclick="cashLoad()">Refresh</button></div>
  <div id="cashMetrics" class="cash-metrics"></div><div id="cashCharts" class="ems-panels"></div>
  <section class="card"><div class="cash-toolbar"><input id="cashSearch" aria-label="Search cash entries" placeholder="Search entries…" maxlength="200"><div id="cashCategoryPicker"></div></div>
    <div id="cashRows" aria-live="polite"></div><div class="cash-toolbar cash-pagination"><span id="cashPage"></span><button class="btn ghost" id="cashPrevious" onclick="cashPage(-1)">Previous</button><button class="btn ghost" id="cashNext" onclick="cashPage(1)">Next</button></div>
  </section></section>
<section id="cashAdmin" class="hidden"><h2>Cash Settings</h2>
  <section class="card"><h3>Access</h3><div class="cash-access-heading" aria-hidden="true"><span>Employee</span><span>Cash Access</span><span></span></div><div id="cashAccessRows"></div></section>
  <section class="card"><h3>Import Legacy Data</h3><form id="cashImportForm" class="cash-toolbar"><div class="cash-file-picker"><input id="cashImportFile" class="file-input-hidden" type="file" accept=".json,application/json" required aria-label="Legacy snapshot JSON"><button type="button" class="btn ghost file-pick-btn" onclick="$('#cashImportFile').click()">Choose File</button><span id="cashImportFileInfo" class="file-pick-info" aria-live="polite">No file selected</span></div><button type="submit" class="btn ghost">Preview Import</button></form><div id="cashImportPreview"></div></section>
  <section class="card"><h3>Daily Backup</h3><div id="cashBackup"></div></section>
  <section class="card"><h3>New Cash Book</h3><form id="cashBookForm" class="cash-form"><label>Name<input name="label" maxlength="100" required></label><label>Year<input name="year" type="number" min="2000" max="2099" value="${new Date().getFullYear()}" required></label><label>Opening Balance<input name="opening_balance" type="text" inputmode="decimal" value="0.00" required></label><button class="btn primary">Create Book</button></form></section>
</section>`);

async function cashLoad(){
  const sequence=++cashState.sequence,owner=currentEmployee?.email;
  $('#cashRows').textContent='Loading…';$('#cashMetrics').innerHTML='';$('#cashCharts').innerHTML='';
  $('#cashNew').classList.toggle('hidden',currentEmployee?.cash_access!=='MANAGE');
  try{
    const data=await api('/api/cash/books');if(sequence!==cashState.sequence||owner!==currentEmployee?.email||emsView!=='cash')return;
    cashState.categories=data.categories;cashState.book=data.books.some(b=>b.id===cashState.book)?cashState.book:data.books[0]?.id;
    $('#cashBookPicker').innerHTML=cashSelect('cashBook','Book',data.books.map(b=>[b.id,b.label]),cashState.book);
    $('#cashCategoryPicker').innerHTML=cashSelect('cashCategory','Category',[['','All categories'],...data.categories.map(c=>[c,c])],'');syncAdminWorkflowSelects();
    $('#cashBook').onchange=()=>{cashState.book=$('#cashBook').value;cashState.offset=0;cashLoad()};
    $('#cashCategory').onchange=()=>{cashState.offset=0;cashLoadRows()};
    $('#cashNew').disabled=!cashState.book;
    if(!cashState.book){$('#cashRows').innerHTML='<div class="empty">No cash book yet.</div>';$('#cashPage').textContent='';$('#cashPrevious').disabled=true;$('#cashNext').disabled=true;return;}
    const overview=await api('/api/cash/overview?book='+encodeURIComponent(cashState.book));
    if(sequence!==cashState.sequence||owner!==currentEmployee?.email||emsView!=='cash')return;
    $('#cashMetrics').innerHTML=[['Opening Balance','opening'],['Income','income'],['Outcome','outcome'],['Current Balance','balance']].map(([label,key])=>`<div class="card cash-metric"><span>${label}</span><strong>${cashMoney(overview.totals[key])}</strong></div>`).join('');
    const max=Math.max(1,...overview.trend.flatMap(r=>[Number(r.income),Number(r.outcome)]));
    $('#cashCharts').innerHTML=`<section class="card"><h3>Monthly Cash Flow</h3><div class="cash-legend"><span>Income</span><span>Outcome</span></div>${overview.trend.map(r=>`<div class="cash-month"><span>${esc(r.month)}</span><div><div class="cash-bar in" style="width:${Number(r.income)/max*100}%"></div><div class="cash-bar out" style="width:${Number(r.outcome)/max*100}%"></div></div><small>${cashMoney(r.income)} / ${cashMoney(r.outcome)}</small></div>`).join('')||'<div class="empty">No transactions.</div>'}</section><section class="card"><h3>Outcome by Category</h3><div class="cash-category-list">${overview.categories.map(r=>`<div><span>${esc(r.category)}</span><strong>${cashMoney(r.amount)}</strong></div>`).join('')||'<div class="empty">No outcome.</div>'}</div></section>`;
    await cashLoadRows();
  }catch(e){if(owner===currentEmployee?.email){$('#cashRows').textContent='Unable to load cash data.';msg(e.message,'err')}}
}
let cashRowsSequence=0;
async function cashLoadRows(){
  if(!cashState.book||emsView!=='cash')return;
  const sequence=++cashRowsSequence,owner=currentEmployee?.email;
  try{
    const data=await api('/api/cash/entries?'+new URLSearchParams({book:cashState.book,offset:cashState.offset,q:$('#cashSearch').value,category:$('#cashCategory')?.value||''}));
    if(sequence!==cashRowsSequence||owner!==currentEmployee?.email||emsView!=='cash')return;
    cashState.entries=data.entries;
    $('#cashRows').innerHTML=data.entries.length?`<div class="table-wrap"><table class="cash-table"><thead><tr><th>Date</th><th>Category</th><th>Activity</th><th>Income</th><th>Outcome</th><th>Balance</th><th></th></tr></thead><tbody>${data.entries.map(e=>`<tr class="${e.voided?'cash-voided':''}"><td>${esc(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.activity||'—')}<small>${e.origin==='LEGACY'?'Legacy · row '+e.source_row:'EMS'}${e.voided?' · Voided':''}</small></td><td class="money">${cashMoney(e.income)}</td><td class="money">${cashMoney(e.outcome)}</td><td class="money">${cashMoney(e.balance)}</td><td><button class="btn tiny ghost" data-cash-open="${e.id}">Open</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No matching entries.</div>';
    $('#cashRows').querySelectorAll('[data-cash-open]').forEach(b=>b.onclick=()=>cashDetail(b.dataset.cashOpen));
    $('#cashPage').textContent=data.total?`${data.offset+1}–${Math.min(data.offset+50,data.total)} of ${data.total}`:'0 entries';
    $('#cashPrevious').disabled=!cashState.offset;$('#cashNext').disabled=data.offset+50>=data.total;
  }catch(e){if(owner===currentEmployee?.email)msg(e.message,'err')}
}
function cashPage(direction){cashState.offset=Math.max(0,cashState.offset+direction*50);cashLoadRows()}
let cashSearchTimer;$('#cashSearch').oninput=()=>{clearTimeout(cashSearchTimer);cashSearchTimer=setTimeout(()=>{cashState.offset=0;cashLoadRows()},250)};

function cashDialog(title,content){
  $('#cashModal')?.remove();const returnFocus=document.activeElement;
  const modal=document.createElement('div');modal.id='cashModal';modal.className='modal';
  modal.innerHTML=`<section class="profile-modal-panel cash-modal" role="dialog" aria-modal="true" aria-labelledby="cashModalTitle"><div class="modal-head"><h2 id="cashModalTitle">${esc(title)}</h2><button class="btn ghost" data-close>Close</button></div><div class="cash-modal-body">${content}</div></section>`;
  document.body.append(modal);document.body.classList.add('modal-open');
  const close=()=>{modal.remove();document.body.classList.remove('modal-open');returnFocus?.focus()};
  modal.querySelector('[data-close]').onclick=close;modal.onclick=e=>{if(e.target===modal)close()};
  modal.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();close()}if(e.key==='Tab'){const nodes=[...modal.querySelectorAll('input,textarea,button')].filter(x=>!x.disabled&&x.offsetParent!==null);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}};
  modal.querySelector('input,button')?.focus();return {modal,close};
}
function cashEntryModal(){
  const entryId=crypto.randomUUID();
  const {modal,close}=cashDialog('New Entry',`<form id="cashEntryForm" class="cash-form"><label>Date<input name="entry_date" type="date" value="${new Date(Date.now()+7*3600000).toISOString().slice(0,10)}" required></label>${cashSelect('cashEntryCategory','Category',cashState.categories.map(c=>[c,c]),cashState.categories[0])}<label class="span-2">Activity<textarea name="activity" maxlength="4000" rows="2" required></textarea></label><label>Income<input name="income" type="text" inputmode="decimal" value="0.00" required></label><label>Outcome<input name="outcome" type="text" inputmode="decimal" value="0.00" required></label><label class="span-2">Notes<textarea name="notes" maxlength="4000" rows="2"></textarea></label><button type="submit" class="btn primary">Save Entry</button></form>`);
  syncAdminWorkflowSelects();modal.querySelector('form').onsubmit=e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]')||e.target.querySelector('button:last-child');cashBusy(button,'Saving…',async()=>{
    const value=Object.fromEntries(new FormData(e.target));value.id=entryId;value.book_id=cashState.book;value.category=$('#cashEntryCategory').value;
    await api('/api/cash/entries',{method:'POST',body:JSON.stringify(value)});close();await cashLoad();msg('Cash entry saved.');
  })};
}
function cashLog(){
  const owner=currentEmployee?.email;
  const {modal}=cashDialog('Cash Tracker Log','<div id="cashLogRows" aria-live="polite"></div><div class="cash-toolbar cash-pagination"><span id="cashLogPage"></span><button class="btn ghost" id="cashLogPrevious">Previous</button><button class="btn ghost" id="cashLogNext">Next</button></div>');
  let offset=0;
  const previous=modal.querySelector('#cashLogPrevious'),next=modal.querySelector('#cashLogNext');
  async function load(){
    previous.disabled=true;next.disabled=true;modal.querySelector('#cashLogRows').textContent='Loading…';
    try{
      const data=await api('/api/cash/log?offset='+offset);
      if(!modal.isConnected||currentEmployee?.email!==owner||emsView!=='cash')return;
      modal.querySelector('#cashLogRows').innerHTML=data.logs.map(a=>`<article class="cash-log-item"><div class="cash-log-heading"><strong>${esc(cashAction(a.action))}</strong><time>${esc(cashTime(a.created_at))}</time></div><div>${esc(a.actor_name||a.actor_email)}</div><p>${esc(a.action==='LEGACY_IMPORTED'?`${a.imported_count} legacy rows imported`:a.activity||a.book||'—')}</p>${a.book?`<small>Book: ${esc(a.book)}</small>`:''}${a.record_id||a.entry_id||a.import_id?`<small>Record: ${esc(a.record_id||a.entry_id||a.import_id)}</small>`:''}${a.reason?`<p>${esc(a.reason)}</p>`:''}${a.entry_id?`<button class="btn ghost tiny" data-cash-log-entry="${esc(a.entry_id)}">Open Entry</button>`:''}</article>`).join('')||'<div class="empty">No activity yet.</div>';
      modal.querySelectorAll('[data-cash-log-entry]').forEach(b=>b.onclick=()=>cashDetail(b.dataset.cashLogEntry));
      modal.querySelector('#cashLogPage').textContent=data.total?`${data.offset+1}–${Math.min(data.offset+data.limit,data.total)} of ${data.total}`:'0 activities';
      previous.disabled=offset===0;next.disabled=offset+data.limit>=data.total;
    }catch(e){if(modal.isConnected&&currentEmployee?.email===owner){modal.querySelector('#cashLogRows').textContent='Unable to load log.';msg(e.message,'err')}}
  }
  previous.onclick=()=>{offset=Math.max(0,offset-50);load()};next.onclick=()=>{offset+=50;load()};load();
}
async function cashDetail(id){
  const owner=currentEmployee?.email;
  try{
    const data=await api(`/api/cash/entries/${id}/audit`),e=data.entry;
    if(currentEmployee?.email!==owner||emsView!=='cash')return;
    const {modal,close}=cashDialog('Cash Entry',`<dl class="cash-detail"><dt>${e.origin==='LEGACY'?'Imported by':'Created by'}</dt><dd>${esc(e.creator_name||e.created_by||'—')}</dd><dt>Recorded at</dt><dd>${esc(cashTime(e.created_at))}</dd><dt>Activity</dt><dd>${esc(e.activity||'—')}</dd><dt>Category</dt><dd>${esc(e.category)}</dd><dt>Income</dt><dd>${cashMoney(e.income)}</dd><dt>Outcome</dt><dd>${cashMoney(e.outcome)}</dd><dt>Notes</dt><dd>${esc(e.notes||'—')}</dd><dt>Source</dt><dd>${e.origin==='LEGACY'?'Legacy · row '+e.source_row:'EMS'}</dd></dl><h3>Audit Trail</h3>${data.audit.map(a=>`<div class="cash-audit"><strong>${esc(cashAction(a.action))}</strong><span>${esc(a.actor_name||a.actor_email)} · ${esc(cashTime(a.created_at))}</span><p>${esc(a.reason)}</p></div>`).join('')||'<p>Imported from the legacy spreadsheet.</p>'}${!e.voided&&currentEmployee.cash_access==='MANAGE'?'<form id="cashVoidForm"><label>Correction Reason<textarea name="reason" rows="2" maxlength="4000" required></textarea></label><button class="btn danger" type="submit">Void Entry</button></form>':''}`);
    modal.querySelector('#cashVoidForm')?.addEventListener('submit',event=>{event.preventDefault();cashBusy(event.target.querySelector('button'),'Saving…',async()=>{await api(`/api/cash/entries/${id}/void`,{method:'POST',body:JSON.stringify({reason:event.target.elements.reason.value,version:e.version})});close();await cashLoad();msg('Entry voided. Add a new entry for the corrected amount.');})});
  }catch(e){msg(e.message,'err')}
}
async function cashAdminLoad(){
  try{
    const [access,status]=await Promise.all([api('/api/admin/cash/access'),api('/api/admin/cash/backup')]);
    if(currentEmployee?.role!=='ADMIN'||emsView!=='admin-cash')return;
    $('#cashAccessRows').innerHTML=access.users.map((u,i)=>`<div class="cash-access-row"><span>${esc(u.name)}${u.active?'':' · Inactive'}</span>${cashSelect('cashAccess'+i,'Cash Access',[['NONE','No Access'],['VIEW','View'],['MANAGE','Manage']],u.access)}<button class="btn ghost" data-cash-grant="${i}">Save</button></div>`).join('');
    $('#cashAccessRows').querySelectorAll('[data-cash-grant]').forEach(b=>b.onclick=()=>cashBusy(b,'Saving…',async()=>{const i=Number(b.dataset.cashGrant);await api('/api/admin/cash/access',{method:'PUT',body:JSON.stringify({email:access.users[i].email,access:$('#cashAccess'+i).value})});msg('Cash access saved.');await loadMe()}));
    const s=status.settings;
    $('#cashBackup').innerHTML=`<form id="cashBackupForm" class="cash-form"><label class="span-2">Spreadsheet ID<input name="spreadsheet_id" value="${esc(s.spreadsheet_id)}" required></label><label>Hour (WIB)<input type="number" name="hour_wib" min="0" max="23" value="${s.hour_wib}" required></label><label class="cash-checkbox"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Daily Backup</label><span class="span-2">Google credential: ${status.credentialConfigured?'Configured':'Not configured'}</span><button class="btn primary">Save Settings</button><button type="button" class="btn ghost" id="cashBackupNow" ${status.credentialConfigured?'':'disabled'}>Back Up Now</button></form><div class="cash-backup-runs">${status.runs.map(r=>`<p><strong>${esc(r.state)}</strong> · ${esc(new Date(r.started_at).toLocaleString())}${r.row_count!=null?' · '+r.row_count+' entries':''}${r.error?' · '+esc(r.error):''}</p>`).join('')||'<p>No backups yet.</p>'}</div>`;
    $('#cashBackupForm').onsubmit=e=>{e.preventDefault();cashBusy(e.target.querySelector('button'),'Saving…',async()=>{const value=Object.fromEntries(new FormData(e.target));value.enabled=e.target.elements.enabled.checked;value.hour_wib=Number(value.hour_wib);await api('/api/admin/cash/backup',{method:'PUT',body:JSON.stringify(value)});await cashAdminLoad();msg('Backup settings saved.');})};
    $('#cashBackupNow').onclick=e=>cashBusy(e.target,'Backing Up…',async()=>{await api('/api/admin/cash/backup/run',{method:'POST',body:'{}'});await cashAdminLoad();msg('Backup verified.');});syncAdminWorkflowSelects();
  }catch(e){msg(e.message,'err')}
}
$('#cashBookForm').onsubmit=e=>{e.preventDefault();cashBusy(e.target.querySelector('button'),'Creating…',async()=>{await api('/api/admin/cash/books',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});msg('Cash book created.');})};
$('#cashImportFile').onchange=()=>{$('#cashImportFileInfo').textContent=$('#cashImportFile').files[0]?.name||'No file selected';$('#cashImportPreview').replaceChildren();cashState.preview=null;};
$('#cashImportForm').onsubmit=e=>{e.preventDefault();cashBusy(e.target.querySelector('[type=submit]'),'Reading…',async()=>{
  const form=new FormData();form.append('snapshot',$('#cashImportFile').files[0]);const result=await api('/api/admin/cash/import/preview',{method:'POST',body:form});cashState.preview=result;
  $('#cashImportPreview').innerHTML=`<p>${result.report.count} source rows · ${result.state==='IMPORTED'?'Already imported':'Ready for review'}</p><div class="table-wrap"><table><thead><tr><th>Sheet</th><th>Rows</th><th>Income</th><th>Outcome</th><th>Balance</th></tr></thead><tbody>${result.report.sheets.map(s=>`<tr><td>${esc(s.title)}</td><td>${s.count}</td><td>${cashMoney(s.income)}</td><td>${cashMoney(s.outcome)}</td><td>${cashMoney(s.balance)}</td></tr>`).join('')}</tbody></table></div><ul>${result.report.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>${result.state!=='IMPORTED'?'<label class="cash-checkbox"><input id="cashImportConfirm" type="checkbox"> I reviewed the source rows, separate balances and warnings.</label><button class="btn primary" id="cashImportCommit" disabled>Import All Sheets</button>':''}`;
  $('#cashImportConfirm')?.addEventListener('change',e=>{$('#cashImportCommit').disabled=!e.target.checked});
  $('#cashImportCommit')?.addEventListener('click',e=>cashBusy(e.target,'Importing…',async()=>{await api(`/api/admin/cash/import/${result.id}/commit`,{method:'POST',body:JSON.stringify({checksum:result.report.checksum,confirm:true})});$('#cashImportPreview').textContent=`Import completed: ${result.report.count} source rows.`;msg('Legacy import reconciled.');}));
})};

const cashOriginalResetSession=emsResetSessionState;
emsResetSessionState=function(){cashOriginalResetSession();cashState={book:null,categories:[],offset:0,sequence:cashState.sequence+1,entries:[],preview:null};cashRowsSequence++;$('#cashModal')?.remove();document.body.classList.remove('modal-open');for(const id of ['cashRows','cashMetrics','cashCharts','cashAccessRows','cashBackup','cashImportPreview'])$('#'+id)?.replaceChildren();$('#cashImportFile').value='';$('#cashImportFileInfo').textContent='No file selected';$('#cashSearch').value='';};
