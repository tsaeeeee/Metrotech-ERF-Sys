// Mirrored from src/access.js; checked by the multi-role regression test.
const FORM_ROLES={ERF:['REQUESTOR','REVIEWER','APPROVER'],ECF:['REQUESTOR','CHECKER','REVIEWER','APPROVER']};

function rolesFor(employee,form='ERF'){
  if(!employee || employee.role==='ADMIN' || employee.active===false) return [];
  if(employee.workflow_roles!=null) return employee.workflow_roles[form]||[];
  const role=form==='ECF'?employee.ecfRole:employee.role;
  return FORM_ROLES[form]?.includes(role)?[role]:[];
}

function hasRole(employee,form,role){return rolesFor(employee,form).includes(role)}
function sameEmail(a,b){return Boolean(a&&b)&&String(a).toLowerCase()===String(b).toLowerCase()}

function normalizeWorkflowRoles(value){
  const invalid=()=>{throw Object.assign(new Error('Select valid ERF and ECF workflow roles.'),{status:400})};
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!FORM_ROLES[k])) invalid();
  const result={};
  for(const [form,allowed] of Object.entries(FORM_ROLES)){
    if(!Array.isArray(value[form]) || value[form].some(role=>!allowed.includes(role))) invalid();
    result[form]=allowed.filter(role=>value[form].includes(role));
  }
  return result;
}

function assignedRole(employee,request){
  const form=request.form_type||'ERF';
  if(request.status!=='PENDING_APPROVAL' && sameEmail(employee?.email,request.requester_email)) return null;
  const stage={PENDING_CHECK:['CHECKER','checker_email'],PENDING_REVIEW:['REVIEWER','reviewer_email'],PENDING_APPROVAL:['APPROVER','approver_email']}[request.status];
  if(!stage||!hasRole(employee,form,stage[0]))return null;
  const plan=request.workflow_plan;
  if(stage[0]!=='APPROVER'&&plan?.bypass)return null;
  if(stage[0]==='REVIEWER'&&plan&&!plan.reviewTakenOver)
    return plan.reviewers.some(e=>sameEmail(e.email,employee.email))?'REVIEWER':null;
  return sameEmail(employee.email,request[stage[1]])?stage[0]:null;
}

function recallRole(employee,request){
  const form=request.form_type||'ERF';
  if(request.status!=='APPROVED' && sameEmail(employee?.email,request.requester_email))
    return hasRole(employee,form,'REQUESTOR')?'REQUESTOR':null;
  if(request.status==='APPROVED' && hasRole(employee,form,'APPROVER') && sameEmail(employee.email,request.approver_email)) return 'APPROVER';
  if(form==='ERF' && request.status==='PENDING_APPROVAL' && hasRole(employee,form,'REVIEWER') && sameEmail(employee.email,request.reviewer_email)) return 'REVIEWER';
  return null;
}

function canBypass(employee,form){
  return hasRole(employee,form,'REQUESTOR')&&hasRole(employee,form,'APPROVER')&&employee.workflow_options?.[form]?.bypass===true;
}
function takeoverRole(employee,request){
  const form=request.form_type||'ERF',plan=request.workflow_plan;
  if(!plan||plan.bypass||sameEmail(employee?.email,request.requester_email)||!hasRole(employee,form,'APPROVER')||!sameEmail(employee.email,request.approver_email))return null;
  for(const [status,role,key,taken,option] of [['PENDING_REVIEW','REVIEWER','secondaryReviewers','reviewTakenOver','review'],['PENDING_CHECK','CHECKER','secondaryCheckers','checkTakenOver','check']]){
    if(request.status===status&&!plan[taken]&&hasRole(employee,form,role)&&employee.workflow_options?.[form]?.[option]==='SECONDARY'&&plan[key].some(e=>sameEmail(e.email,employee.email)))return role;
  }
  return null;
}
function isWorkflowParticipant(employee,request){
  const form=request.form_type||'ERF',plan=request.workflow_plan;
  if(!plan)return false;
  return (hasRole(employee,form,'REVIEWER')&&[...plan.reviewers,...plan.secondaryReviewers].some(e=>sameEmail(e.email,employee.email)))||
    (hasRole(employee,form,'CHECKER')&&[plan.checker,...plan.secondaryCheckers].some(e=>sameEmail(e?.email,employee.email)));
}
