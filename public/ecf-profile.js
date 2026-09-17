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
    .ecf-payment-heading{
      grid-column:1/-1;
      margin-top:2px;
      padding-top:16px;
      border-top:1px solid #e2e8f0;
    }
    .ecf-payment-heading h3{margin:0 0 3px;color:#0b3768;font-size:14px}
    .ecf-payment-heading p{margin:0;color:#667085;font-size:11.5px;line-height:1.45}
    .ecf-bank-field select{
      width:100%;
      height:42px;
      border:1px solid #cbd5e1;
      border-radius:9px;
      padding:9px 11px;
      font:inherit;
      background:#fff;
      color:#172033;
    }
    .ecf-payment-display{
      grid-column:1/-1;
      display:flex;
      align-items:center;
      gap:8px;
      margin:-2px 0 0;
      padding:9px 11px;
      border:1px solid #e2e8f0;
      border-radius:10px;
      background:#f8fafc;
      color:#475467;
      font-size:11px;
      line-height:1.4;
    }
    .ecf-payment-display strong{color:#0b3768}
    @media(max-width:760px){
      .ecf-payment-heading,.ecf-payment-display{grid-column:1}
    }
  `;
  document.head.appendChild(style);
}

function ecfEnsurePaymentFields(){
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  ecfProfileInjectStyles();
  const form=document.getElementById('profileForm');
  if(!form) return;

  const signature=document.getElementById('profileSignature');
  signature?.removeAttribute('required');

  if(document.getElementById('profilePaymentTo')) return;
  const actions=form.querySelector('.profile-form-actions');
  if(!actions) return;

  const heading=document.createElement('div');
  heading.className='ecf-payment-heading';
  heading.innerHTML=`
    <h3>Payment Information</h3>
    <p>Used for Expense Claim Form (ECF). You can update your own payment destination here.</p>`;

  const paymentTo=document.createElement('div');
  paymentTo.className='field';
  paymentTo.innerHTML=`<label>Payment To</label><input id="profilePaymentTo" maxlength="160" autocomplete="name" placeholder="Beneficiary name">`;

  const bank=document.createElement('div');
  bank.className='field ecf-bank-field';
  bank.innerHTML=`
    <label>Bank</label>
    <select id="profileBankSelect">
      <option value="">Choose bank</option>
    </select>`;

  const accountNumber=document.createElement('div');
  accountNumber.className='field';
  accountNumber.innerHTML=`<label>Account Number</label><input id="profileAccountNumber" maxlength="80" inputmode="numeric" autocomplete="off" placeholder="Account number">`;

  const note=document.createElement('div');
  note.className='ecf-payment-display';
  note.innerHTML='<strong>Bank code is automatic.</strong> Choose the bank once; the code is included in the selected bank name and stored automatically.';

  form.insertBefore(heading,actions);
  form.insertBefore(paymentTo,actions);
  form.insertBefore(bank,actions);
  form.insertBefore(accountNumber,actions);
  form.insertBefore(note,actions);

  const button=document.getElementById('saveProfileBtn');
  if(button) button.textContent='Save Profile';
}

function ecfRenderBankOptions(profile=ecfPaymentProfile){
  const select=document.getElementById('profileBankSelect');
  if(!select) return;

  const currentCode=String(profile.bankCode||'').trim();
  const currentName=String(profile.bankName||'').trim();
  const matched=ecfBankDirectory.some(bank=>bank.code===currentCode && bank.name===currentName);

  const options=['<option value="">Choose bank</option>'];
  if((currentCode||currentName) && !matched){
    const label=`${currentName||'Current bank'}${currentCode?` (${currentCode})`:''}`;
    options.push(`<option value="${esc(currentCode)}" data-name="${esc(currentName)}">${esc(label)} — current saved value</option>`);
  }
  options.push(...ecfBankDirectory.map(bank=>
    `<option value="${esc(bank.code)}" data-name="${esc(bank.name)}">${esc(bank.name)} (${esc(bank.code)})</option>`
  ));
  select.innerHTML=options.join('');
  select.value=currentCode;
}

function ecfSetPaymentFields(profile={}){
  ecfPaymentProfile={
    paymentTo:String(profile.paymentTo??profile.payment_to??''),
    bankName:String(profile.bankName??profile.bank_name??''),
    bankCode:String(profile.bankCode??profile.bank_code??''),
    accountNumber:String(profile.accountNumber??profile.account_number??'')
  };
  if(document.getElementById('profilePaymentTo')) document.getElementById('profilePaymentTo').value=ecfPaymentProfile.paymentTo;
  if(document.getElementById('profileAccountNumber')) document.getElementById('profileAccountNumber').value=ecfPaymentProfile.accountNumber;
  ecfRenderBankOptions(ecfPaymentProfile);
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
    ecfLoadPaymentProfile();
  }
  return result;
};

saveProfile=async function(event){
  event.preventDefault();
  if(!currentEmployee || currentEmployee.role==='ADMIN') return;
  ecfEnsurePaymentFields();

  const sig=document.getElementById('profileSignature')?.files?.[0]||null;
  const paymentTo=document.getElementById('profilePaymentTo')?.value.trim()||'';
  const bankSelect=document.getElementById('profileBankSelect');
  const selectedOption=bankSelect?.selectedOptions?.[0]||null;
  const bankCode=String(bankSelect?.value||'').trim();
  const bankName=String(selectedOption?.dataset?.name||'').trim();
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
