// ECF payment-profile extension.
// Loaded after the stable app + request-type extension so My Profile can expose
// employee-managed payment information without changing ERF employee master data.

let ecfPaymentProfile={
  paymentTo:'',
  bankName:'',
  bankCode:'',
  accountNumber:''
};

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

  const bankName=document.createElement('div');
  bankName.className='field';
  bankName.innerHTML=`<label>Bank Name</label><input id="profileBankName" maxlength="80" placeholder="e.g. BCA">`;

  const bankCode=document.createElement('div');
  bankCode.className='field';
  bankCode.innerHTML=`<label>Bank Code</label><input id="profileBankCode" maxlength="20" inputmode="numeric" placeholder="e.g. 014">`;

  const accountNumber=document.createElement('div');
  accountNumber.className='field';
  accountNumber.innerHTML=`<label>Account Number</label><input id="profileAccountNumber" maxlength="80" inputmode="numeric" autocomplete="off" placeholder="Account number">`;

  const note=document.createElement('div');
  note.className='ecf-payment-display';
  note.innerHTML='<strong>PDF display:</strong> Bank Name and Bank Code will appear together, for example BCA (014).';

  form.insertBefore(heading,actions);
  form.insertBefore(paymentTo,actions);
  form.insertBefore(bankName,actions);
  form.insertBefore(bankCode,actions);
  form.insertBefore(accountNumber,actions);
  form.insertBefore(note,actions);

  const button=document.getElementById('saveProfileBtn');
  if(button) button.textContent='Save Profile';
}

function ecfSetPaymentFields(profile={}){
  ecfPaymentProfile={
    paymentTo:String(profile.paymentTo??profile.payment_to??''),
    bankName:String(profile.bankName??profile.bank_name??''),
    bankCode:String(profile.bankCode??profile.bank_code??''),
    accountNumber:String(profile.accountNumber??profile.account_number??'')
  };
  if(document.getElementById('profilePaymentTo')) document.getElementById('profilePaymentTo').value=ecfPaymentProfile.paymentTo;
  if(document.getElementById('profileBankName')) document.getElementById('profileBankName').value=ecfPaymentProfile.bankName;
  if(document.getElementById('profileBankCode')) document.getElementById('profileBankCode').value=ecfPaymentProfile.bankCode;
  if(document.getElementById('profileAccountNumber')) document.getElementById('profileAccountNumber').value=ecfPaymentProfile.accountNumber;
}

async function ecfLoadPaymentProfile(){
  ecfEnsurePaymentFields();
  try{
    const data=await api('/api/profile/payment');
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
  const bankName=document.getElementById('profileBankName')?.value.trim()||'';
  const bankCode=document.getElementById('profileBankCode')?.value.trim()||'';
  const accountNumber=document.getElementById('profileAccountNumber')?.value.trim()||'';

  const btn=document.getElementById('saveProfileBtn');
  btn.disabled=true;
  btn.textContent='Saving…';
  try{
    const fd=new FormData();
    fd.append('paymentTo',paymentTo);
    fd.append('bankName',bankName);
    fd.append('bankCode',bankCode);
    fd.append('accountNumber',accountNumber);
    if(sig) fd.append('signature',sig,sig.name);

    const result=await api('/api/profile',{method:'PUT',body:fd});
    if(result.employee) currentEmployee=result.employee;
    ecfSetPaymentFields(result.paymentProfile||{paymentTo,bankName,bankCode,accountNumber});
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
