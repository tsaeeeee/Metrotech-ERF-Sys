import {sameEmail} from './access.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
export function normalizeWorkflowOptions(value,roles){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['ERF','ECF','displayName'].includes(k)))
    fail('Invalid workflow options.');
  const result={displayName:String(value.displayName||'').trim().slice(0,40)};
  for(const form of ['ERF','ECF']){
    const option=value[form]||{};
    if(typeof option!=='object'||Array.isArray(option)||Object.keys(option).some(k=>!['review','check','bypass'].includes(k)))fail('Invalid workflow options.');
    const review=option.review||'ASSIGNED',check=option.check||'PRIMARY',bypass=option.bypass??false;
    if(!['ASSIGNED','PRIMARY','SECONDARY'].includes(review)||!['PRIMARY','SECONDARY'].includes(check)||typeof bypass!=='boolean')fail('Invalid workflow options.');
    const access=roles[form]||[];
    if(review!=='ASSIGNED'&&!access.includes('REVIEWER'))fail(`${form} Reviewer access is required for review routing.`);
    if((review==='SECONDARY'||check==='SECONDARY'||bypass)&&!access.includes('APPROVER'))fail('Executive privileges require Approver access.');
    if(check==='SECONDARY'&&(form!=='ECF'||!access.includes('CHECKER')))fail('Secondary checking requires ECF Checker access.');
    if(bypass&&!access.includes('REQUESTOR'))fail('Own-request bypass requires Requestor access.');
    result[form]={review,check,bypass};
  }
  return result;
}

export function submissionOptions(body={}){
  const raw=body.bypass;
  if(raw!==undefined&&![true,false,'true','false'].includes(raw))fail('Invalid bypass choice.');
  return {bypass:raw===true||raw==='true',bypassReason:String(body.bypassReason||'').trim()};
}

export async function buildWorkflowPlan(client,employee,form,options={}){
  const {rows}=await client.query(`select e.email,e.name,e.workflow_options,
      employee_has_workflow_role(e.email,$1,'REVIEWER') as reviewer,
      employee_has_workflow_role(e.email,$1,'CHECKER') as checker,
      employee_has_workflow_role(e.email,$1,'APPROVER') as approver
    from employees e where active=true and role<>'ADMIN' order by lower(e.name),lower(e.email)`,[form]);
  const own=rows.find(e=>sameEmail(e.email,employee.email));
  const member=e=>({email:e.email,name:e.name,label:e.workflow_options?.displayName||e.name});
  const other=rows.filter(e=>!sameEmail(e.email,employee.email));
  const reviewMode=e=>e.workflow_options?.[form]?.review||'ASSIGNED';
  let reviewers=other.filter(e=>e.reviewer&&reviewMode(e)==='PRIMARY');
  if(!reviewers.length){
    const legacy=other.filter(e=>e.reviewer&&reviewMode(e)==='ASSIGNED');
    // Preserve individual load-based assignment until primary reviewers are configured.
    const counts=(await client.query(`select lower(reviewer_email) as email,count(*)::int n
      from requests where form_type=$1 and status='PENDING_REVIEW' group by lower(reviewer_email)`,[form])).rows;
    legacy.sort((a,b)=>(counts.find(c=>c.email===a.email.toLowerCase())?.n||0)-(counts.find(c=>c.email===b.email.toLowerCase())?.n||0));
    reviewers=legacy.slice(0,1);
  }
  const secondaryReviewers=other.filter(e=>e.reviewer&&e.approver&&reviewMode(e)==='SECONDARY');
  const checkers=form==='ECF'?other.filter(e=>e.checker&&e.workflow_options?.ECF?.check!=='SECONDARY'):[];
  const secondaryCheckers=form==='ECF'?other.filter(e=>e.checker&&e.approver&&e.workflow_options?.ECF?.check==='SECONDARY'):[];
  if(checkers.length>1){
    const counts=(await client.query(`select lower(d.checker_email) as email,count(*)::int n from requests r
      join ecf_details d on d.request_id=r.id where status='PENDING_CHECK' group by lower(d.checker_email)`)).rows;
    checkers.sort((a,b)=>(counts.find(c=>c.email===a.email.toLowerCase())?.n||0)-(counts.find(c=>c.email===b.email.toLowerCase())?.n||0));
  }
  const bypass=options.bypass===true;
  if(bypass){
    if(!own?.approver||!own.workflow_options?.[form]?.bypass)fail('Executive bypass is not enabled for this account.',403);
    if(!String(options.bypassReason||'').trim())fail('A bypass reason is required.');
    if(String(options.bypassReason).length>4000)fail('Bypass reason must be at most 4000 characters.');
  }else{
    if(!reviewers.length&&!secondaryReviewers.length)fail('Assign another active Reviewer before submitting.',409);
    if(form==='ECF'&&!checkers.length&&!secondaryCheckers.length)fail('Assign another active ECF Checker before submitting.',409);
  }
  return {reviewers:reviewers.map(member),secondaryReviewers:secondaryReviewers.map(member),
    checker:checkers[0]?member(checkers[0]):null,secondaryCheckers:secondaryCheckers.map(member),
    reviewTakenOver:false,checkTakenOver:false,bypass,bypassReason:bypass?String(options.bypassReason).trim():''};
}

export function reviewRecipients(request){
  if(request.workflow_plan&&!request.workflow_plan.reviewTakenOver)
    return request.workflow_plan.reviewers.map(e=>e.email);
  return request.reviewer_email?[request.reviewer_email]:[];
}
export function pendingRecipients(request){
  if(request.status==='PENDING_APPROVAL')return [request.approver_email];
  if(request.status==='PENDING_CHECK')return request.checker_email?[request.checker_email]:[];
  return reviewRecipients(request);
}
export function annotateProgress(request){
  const plan=request.workflow_plan;
  if(!plan)return request;
  if(plan.bypass){
    request.reviewer_name='Bypassed by executive';request.checker_name='Bypassed by executive';
    request.reviewer_signature=null;request.checker_signature=null;
  }else if(['PENDING_CHECK','PENDING_REVIEW'].includes(request.status)&&!plan.reviewTakenOver){
    request.reviewer_name=plan.reviewers.map(e=>e.label||e.name).join('/')||'Awaiting manual takeover';
    if(request.status==='PENDING_REVIEW')request.waiting_for_name=request.reviewer_name;
  }
  if(request.status==='PENDING_CHECK'&&!request.checker_email)request.waiting_for_name='Awaiting manual takeover';
  return request;
}
