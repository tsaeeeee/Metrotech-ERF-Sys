// ECF payment-profile extension.
// Loaded after the stable app + request-type extension so My Profile can expose
// employee-managed payment information without changing ERF employee master data.

let ecfPaymentProfile={
  paymentTo:'',
  bankName:'',
  bankCode:'',
  accountNumber:''
};
let ecfBankDirectory=[];

function ecfProfileInjectStyles(){
  if(document.getElementById('ecfProfileStyles')) return;
  const style=document.createElement('style');
  style.id='ecfProfileStyles';
  style.textContent=`
    .ecf-payment-section{
      margin-top:20px;
      padding-top:20px;
      border-top:1px solid #e2e8f0;
      display:grid;
      gap:16px;
    }
    .ecf-payment-heading h3{
      margin:0;
      color:#0b3768;
      font-size:14px;
    }
    .ecf-payment-section .field label{
      margin-bottom:7px;
    }
    .ecf-bank-field{
      position:relative;
    }
    .ecf-bank-field:has(.custom-select.open){
      z-index:40;
    }
    #profileBankLabel{
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .ecf-bank-menu{
      width:100%;
      max-height:none;
      overflow:hidden;
      padding:0;
    }
    .ecf-bank-search-wrap{
      padding:8px;
      border-bottom:1px solid #eef2f6;
      background:#fff;
    }
    .profile-form .ecf-bank-search{
      width:100%;
      height:38px;
      border:1px solid #cbd5e1;
      border-radius:8px;
      padding:0 10px;
      background:#fff;
      color:var(--text);
      font:inherit;
      font-size:12px;
      outline:none;
    }
    .profile-form .ecf-bank-search:focus{
      border-color:#8fa8c2;
      box-shadow:0 0 0 2px rgba(11,55,104,.08);
    }
    .ecf-bank-options{
      max-height:238px;
      overflow:auto;
      padding:5px;
    }
    .ecf-bank-empty{
      padding:15px 10px;
      color:var(--muted);
      font-size:12px;
      text-align:center;
    }
    @media(max-width:760px){
      .ecf-payment-section{gap:14px}
    }
  `;
  document.head.appendChild(style);
}

function ecfBankLabel(bank){
  if(!bank) return '';
  return `${bank.name} (${bank.code})`;
}

function ecfCloseBankMenu(){
  const select=document.getElementById('profileBankSelect');
  const menu=document.getElementById('profileBankMenu');
  const button=document.getElementById('profileBankButton');
  if(!select||!menu||!button) return;
  select.classList.remove('open');
  menu.classList.add('hidden');
  button.setAttribute('aria-expanded','false');
}

function ecfRenderBankOptions(query=''){
  const host=document.getElementById('profileBankOptions');
  if(!host) return;

  const needle=String(query||'').trim().toLowerCase();
  const selectedCode=String(document.getElementById('profileBankCode')?.value||'').trim();
  const rows=ecfBankDirectory.filter(bank=>{
    if(!needle) return true;
    return String(bank.name||'').toLowerCase().includes(needle)
      || String(bank.code||'').toLowerCase().includes(needle);
  });

  if(!rows.length){
    host.innerHTML='<div class="ecf-bank-empty">No bank found.</div>';
    return;
  }

  host.innerHTML=rows.map(bank=>`
    <button type="button" role="option" data-bank-code="${esc(bank.code)}"
      class="${bank.code===selectedCode?'selected':''}"
      aria-selected="${bank.code===selectedCode?'true':'false'}">
      ${esc(ecfBankLabel(bank))}
    </button>`).join('');
}

function ecfSetBankSelection(bank){
  const bankName=document.getElementById('profileBankName');
  const bankCode=document.getElementById('profileBankCode');
  const label=document.getElementById('profileBankLabel');
  if(!bankName||!bankCode||!label) return;

  bankName.value=bank?.name||'';
  bankCode.value=bank?.code||'';
  label.textContent=bank?ecfBankLabel(bank):'Select bank';
  label.classList.toggle('custom-select-placeholder',!bank);
  ecfRenderBankOptions(document.getElementById('profileBankSearch')?.value||'');
}

function ecfChooseBank(code){
  const bank=ecfBankDirectory.find(row=>String(row.code)===String(code));
  if(!bank) return;
  ecfSetBankSelection(bank);
  ecfCloseBankMenu();
}

function ecfToggleBankMenu(event){
  event?.stopPropagation();
  const select=document.getElementById('profileBankSelect');
  const menu=document.getElementById('profileBankMenu');
  const button=document.getElementById('profileBankButton');
  const search=document.getElementById('profileBankSearch');
  if(!select||!menu||!button||!search) return;

  const opening=menu.classList.contains('hidden');
  if(!opening){
    ecfCloseBankMenu();
    return;
  }

  select.classList.add('open');
  menu.classList.remove('hidden');
  button.setAttribute('aria-expanded','true');
  search.value='';
  ecfRenderBankOptions('');
  window.setTimeout(()=>search.focus(),0);
}

function ecfEnsurePaymentFields(){
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  ecfProfileInjectStyles();
  const form=document.getElementById('profileForm');
  if(!form) return;

  const signature=document.getElementById('profileSignature');
  signature?.removeAttribute('required');

  if(document.getElementById('profilePaymentSection')) return;
  const actions=form.querySelector('.profile-form-actions');
  if(!actions) return;

  const section=document.createElement('div');
  section.id='profilePaymentSection';
  section.className='ecf-payment-section';
  section.innerHTML=`
    <div class="ecf-payment-heading"><h3>Payment Information</h3></div>

    <div class="field">
      <label>Payment To</label>
      <input id="profilePaymentTo" maxlength="160" autocomplete="name" placeholder="Beneficiary name">
    </div>

    <div class="field ecf-bank-field">
      <label>Bank</label>
      <input id="profileBankName" type="hidden">
      <input id="profileBankCode" type="hidden">
      <div id="profileBankSelect" class="custom-select">
        <button id="profileBankButton" class="custom-select-trigger" type="button"
          aria-haspopup="listbox" aria-expanded="false">
          <span id="profileBankLabel" class="custom-select-placeholder">Select bank</span>
          <span class="custom-select-chevron">⌄</span>
        </button>
        <div id="profileBankMenu" class="custom-select-menu ecf-bank-menu hidden" role="listbox">
          <div class="ecf-bank-search-wrap">
            <input id="profileBankSearch" class="ecf-bank-search" type="search"
              placeholder="Search bank name or code…" autocomplete="off">
          </div>
          <div id="profileBankOptions" class="ecf-bank-options"></div>
        </div>
      </div>
    </div>

    <div class="field">
      <label>Account Number</label>
      <input id="profileAccountNumber" maxlength="80" inputmode="numeric" autocomplete="off" placeholder="Account number">
    </div>`;

  form.insertBefore(section,actions);

  document.getElementById('profileBankButton')?.addEventListener('click',ecfToggleBankMenu);
  document.getElementById('profileBankMenu')?.addEventListener('click',event=>event.stopPropagation());
  document.getElementById('profileBankOptions')?.addEventListener('click',event=>{
    const option=event.target.closest('button[data-bank-code]');
    if(option) ecfChooseBank(option.dataset.bankCode);
  });
  document.getElementById('profileBankSearch')?.addEventListener('input',event=>{
    ecfRenderBankOptions(event.target.value);
  });
  document.getElementById('profileBankSearch')?.addEventListener('keydown',event=>{
    if(event.key==='Escape'){
      event.preventDefault();
      ecfCloseBankMenu();
      document.getElementById('profileBankButton')?.focus();
      return;
    }
    if(event.key==='Enter'){
      const first=document.querySelector('#profileBankOptions button[data-bank-code]');
      if(first){
        event.preventDefault();
        ecfChooseBank(first.dataset.bankCode);
      }
    }
  });

  const button=document.getElementById('saveProfileBtn');
  if(button) button.textContent='Save Profile';
}

function ecfSetPaymentFields(profile={}){
  const raw={
    paymentTo:String(profile.paymentTo??profile.payment_to??''),
    bankName:String(profile.bankName??profile.bank_name??''),
    bankCode:String(profile.bankCode??profile.bank_code??''),
    accountNumber:String(profile.accountNumber??profile.account_number??'')
  };
  const canonical=ecfBankDirectory.find(bank=>String(bank.code)===raw.bankCode);
  ecfPaymentProfile={
    ...raw,
    bankName:canonical?.name||raw.bankName,
    bankCode:canonical?.code||raw.bankCode
  };

  if(document.getElementById('profilePaymentTo'))
    document.getElementById('profilePaymentTo').value=ecfPaymentProfile.paymentTo;
  if(document.getElementById('profileAccountNumber'))
    document.getElementById('profileAccountNumber').value=ecfPaymentProfile.accountNumber;

  if(canonical){
    ecfSetBankSelection(canonical);
  }else{
    const bankName=document.getElementById('profileBankName');
    const bankCode=document.getElementById('profileBankCode');
    const label=document.getElementById('profileBankLabel');
    if(bankName) bankName.value=ecfPaymentProfile.bankName;
    if(bankCode) bankCode.value=ecfPaymentProfile.bankCode;
    if(label){
      const hasSaved=Boolean(ecfPaymentProfile.bankName||ecfPaymentProfile.bankCode);
      label.textContent=hasSaved
        ? `${ecfPaymentProfile.bankName||'Current bank'}${ecfPaymentProfile.bankCode?` (${ecfPaymentProfile.bankCode})`:''}`
        : 'Select bank';
      label.classList.toggle('custom-select-placeholder',!hasSaved);
    }
    ecfRenderBankOptions('');
  }
}

async function ecfLoadBankDirectory(){
  if(ecfBankDirectory.length) return ecfBankDirectory;
  const data=await api('/api/profile/payment/banks/read',{method:'POST',body:JSON.stringify({})});
  ecfBankDirectory=Array.isArray(data.banks)?data.banks:[];
  return ecfBankDirectory;
}

async function ecfLoadPaymentProfile(){
  ecfEnsurePaymentFields();
  try{
    const [,data]=await Promise.all([
      ecfLoadBankDirectory(),
      api('/api/profile/payment/read',{method:'POST',body:JSON.stringify({})})
    ]);
    ecfSetPaymentFields(data.paymentProfile||{});
  }catch(e){
    msg(e.message,'err');
  }
}

const ecfProfileOriginalOpenProfileModal=openProfileModal;
openProfileModal=function(...args){
  const result=ecfProfileOriginalOpenProfileModal(...args);
  if(currentEmployee && currentEmployee.role!=='ADMIN'){
    ecfEnsurePaymentFields();
    ecfCloseBankMenu();
    ecfLoadPaymentProfile();
  }
  return result;
};

document.addEventListener('click',event=>{
  const select=document.getElementById('profileBankSelect');
  if(select && !select.contains(event.target)) ecfCloseBankMenu();
});

document.addEventListener('keydown',event=>{
  if(event.key==='Escape') ecfCloseBankMenu();
});

saveProfile=async function(event){
  event.preventDefault();
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  ecfEnsurePaymentFields();

  const sig=document.getElementById('profileSignature')?.files?.[0]||null;
  const paymentTo=document.getElementById('profilePaymentTo')?.value.trim()||'';
  const bankName=document.getElementById('profileBankName')?.value.trim()||'';
  const bankCode=document.getElementById('profileBankCode')?.value.trim()||'';
  const accountNumber=document.getElementById('profileAccountNumber')?.value.trim()||'';

  const btn=document.getElementById('saveProfileBtn');
  btn.disabled=true;
  btn.textContent='Saving…';
  try{
    if(sig){
      const fd=new FormData();
      fd.append('signature',sig,sig.name);
      const signatureResult=await api('/api/profile',{method:'PUT',body:fd});
      if(signatureResult.employee) currentEmployee=signatureResult.employee;
    }

    const paymentResult=await api('/api/profile/payment',{
      method:'PUT',
      body:JSON.stringify({paymentTo,bankName,bankCode,accountNumber})
    });
    ecfSetPaymentFields(paymentResult.paymentProfile||{paymentTo,bankName,bankCode,accountNumber});

    ecfCloseBankMenu();
    closeProfileModal();
    msg('Profile updated successfully.','ok');
    await loadMe();
  }catch(e){
    msg(e.message,'err');
  }finally{
    btn.disabled=false;
    btn.textContent='Save Profile';
  }
};
