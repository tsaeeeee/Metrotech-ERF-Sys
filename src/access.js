export const FORM_ROLES={ERF:['REQUESTOR','REVIEWER','APPROVER'],ECF:['REQUESTOR','CHECKER','REVIEWER','APPROVER']};

export function rolesFor(employee,form='ERF'){
  if(!employee || employee.role==='ADMIN' || employee.active===false) return [];
  if(employee.workflow_roles!=null) return employee.workflow_roles[form]||[];
  const role=form==='ECF'?employee.ecfRole:employee.role;
  return FORM_ROLES[form]?.includes(role)?[role]:[];
}

export function hasRole(employee,form,role){return rolesFor(employee,form).includes(role)}
export function sameEmail(a,b){return Boolean(a&&b)&&String(a).toLowerCase()===String(b).toLowerCase()}

export function normalizeWorkflowRoles(value){
  const invalid=()=>{throw Object.assign(new Error('Select valid ERF and ECF workflow roles.'),{status:400})};
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!FORM_ROLES[k])) invalid();
  const result={};
  for(const [form,allowed] of Object.entries(FORM_ROLES)){
    if(!Array.isArray(value[form]) || value[form].some(role=>!allowed.includes(role))) invalid();
    result[form]=allowed.filter(role=>value[form].includes(role));
  }
  return result;
}

export function assignedRole(employee,request){
  const form=request.form_type||'ERF';
  if(request.status!=='PENDING_APPROVAL' && sameEmail(employee?.email,request.requester_email)) return null;
  const stage={PENDING_CHECK:['CHECKER','checker_email'],PENDING_REVIEW:['REVIEWER','reviewer_email'],PENDING_APPROVAL:['APPROVER','approver_email']}[request.status];
  return stage && hasRole(employee,form,stage[0]) && sameEmail(employee.email,request[stage[1]])?stage[0]:null;
}

export function recallRole(employee,request){
  const form=request.form_type||'ERF';
  if(request.status!=='APPROVED' && sameEmail(employee?.email,request.requester_email))
    return hasRole(employee,form,'REQUESTOR')?'REQUESTOR':null;
  if(request.status==='APPROVED' && hasRole(employee,form,'APPROVER') && sameEmail(employee.email,request.approver_email)) return 'APPROVER';
  if(form==='ERF' && request.status==='PENDING_APPROVAL' && hasRole(employee,form,'REVIEWER') && sameEmail(employee.email,request.reviewer_email)) return 'REVIEWER';
  return null;
}
