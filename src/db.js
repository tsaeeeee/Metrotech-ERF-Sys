import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'db',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'metrotech_erf',
  user: process.env.POSTGRES_USER || 'metrotech_erf',
  password: process.env.POSTGRES_PASSWORD,
  max: 10
});

export async function pingDb() {
  const { rows } = await pool.query('select now() as now');
  return rows[0];
}

export async function listActiveEmployees() {
  const { rows } = await pool.query(
    `select email,name,employee_id,department,location,division,role,signature_file,username
     from employees where active=true order by
     case role when 'REQUESTOR' then 1 when 'REVIEWER' then 2 else 3 end, name`
  );
  return rows;
}

export async function getEmployee(email) {
  const { rows } = await pool.query(
    `select email,name,employee_id,department,location,division,role,signature_file,username
     from employees where lower(email)=lower($1) and active=true limit 1`,
    [email]
  );
  return rows[0] || null;
}

export async function authenticateLocalUser(username,password) {
  const {rows}=await pool.query(
    `select email,name,employee_id,department,location,division,role,signature_file,username
     from employees
     where active=true
       and username is not null
       and lower(username)=lower($1)
       and password_hash is not null
       and password_hash=crypt($2,password_hash)
     limit 1`,
    [String(username||'').trim(),String(password||'')]
  );
  return rows[0] || null;
}

export async function updateEmployeeSignature(email,signatureFile) {
  if(!signatureFile) throw Object.assign(new Error('Choose a signature image first.'),{status:400});
  const {rows}=await pool.query(
    `update employees
     set signature_file=$2
     where lower(email)=lower($1) and active=true
     returning email,name,employee_id,department,location,division,role,signature_file,username`,
    [email,signatureFile]
  );
  if(!rows[0]) throw Object.assign(new Error('Employee not found.'),{status:404});
  return rows[0];
}

export async function listManagedEmployees() {
  const {rows}=await pool.query(
    `select email,name,employee_id,department,location,division,role,active,username,
       (coalesce(signature_file,'')<>'') as has_signature
     from employees
     where role<>'ADMIN'
     order by active desc,name`
  );
  return rows;
}

function validateManagedRole(role){
  const next=String(role||'').trim().toUpperCase();
  if(!['REQUESTOR','REVIEWER','APPROVER'].includes(next))
    throw Object.assign(new Error('Role must be Requestor, Reviewer, or Approver.'),{status:400});
  return next;
}

export async function createManagedEmployee(data) {
  const role=validateManagedRole(data.role);
  const required=['name','email','username','password','employeeId','department','location','division'];
  for(const key of required){
    if(!String(data[key]||'').trim())
      throw Object.assign(new Error(`${key} is required.`),{status:400});
  }

  try{
    const {rows}=await pool.query(
      `insert into employees(
        email,name,employee_id,department,location,division,role,signature_file,active,username,password_hash
       ) values(
        lower($1),$2,$3,$4,$5,$6,$7,'',true,$8,crypt($9,gen_salt('bf',10))
       )
       returning email,name,employee_id,department,location,division,role,active,username,
         false as has_signature`,
      [
        String(data.email).trim(),String(data.name).trim(),String(data.employeeId).trim(),
        String(data.department).trim(),String(data.location).trim(),String(data.division).trim(),
        role,String(data.username).trim(),String(data.password)
      ]
    );
    return rows[0];
  }catch(e){
    if(e.code==='23505') throw Object.assign(new Error('Email or username already exists.'),{status:409});
    throw e;
  }
}

export async function updateManagedEmployee(email,data) {
  const role=validateManagedRole(data.role);
  const required=['name','username','employeeId','department','location','division'];
  for(const key of required){
    if(!String(data[key]||'').trim())
      throw Object.assign(new Error(`${key} is required.`),{status:400});
  }

  try{
    const {rows}=await pool.query(
      `update employees
       set name=$2,
           employee_id=$3,
           department=$4,
           location=$5,
           division=$6,
           role=$7,
           username=$8,
           active=$9,
           password_hash=case when $10<>'' then crypt($10,gen_salt('bf',10)) else password_hash end
       where lower(email)=lower($1) and role<>'ADMIN'
       returning email,name,employee_id,department,location,division,role,active,username,
         (coalesce(signature_file,'')<>'') as has_signature`,
      [
        email,String(data.name).trim(),String(data.employeeId).trim(),String(data.department).trim(),
        String(data.location).trim(),String(data.division).trim(),role,String(data.username).trim(),
        data.active!==false,String(data.password||'')
      ]
    );
    if(!rows[0]) throw Object.assign(new Error('Managed user not found.'),{status:404});
    return rows[0];
  }catch(e){
    if(e.code==='23505') throw Object.assign(new Error('Username already exists.'),{status:409});
    throw e;
  }
}


export async function listRequestsForEmployee(employee) {
  let q, params;
  if (employee.role === 'REQUESTOR') {
    q = `select id,ref_no,request_date,employee_name,total,status,revision,last_rejection_reason,updated_at
         from requests where lower(requester_email)=lower($1)
         order by updated_at desc limit 50`;
    params=[employee.email];
  } else if (employee.role === 'REVIEWER') {
    q = `select id,ref_no,request_date,employee_name,total,status,revision,last_rejection_reason,updated_at
         from requests where lower(reviewer_email)=lower($1) and status='PENDING_REVIEW'
         order by updated_at asc limit 100`;
    params=[employee.email];
  } else if (employee.role === 'APPROVER') {
    q = `select id,ref_no,request_date,employee_name,total,status,revision,last_rejection_reason,updated_at
         from requests where lower(approver_email)=lower($1) and status='PENDING_APPROVAL'
         order by updated_at asc limit 100`;
    params=[employee.email];
  } else {
    return [];
  }
  const { rows } = await pool.query(q,params);
  return rows;
}

async function getWorkflowActorTx(client, role) {
  const preferredName = role==='REVIEWER'
    ? String(process.env.REVIEWER_NAME || '').trim()
    : String(process.env.APPROVER_NAME || '').trim();
  const { rows } = await client.query(
    `select email,name,role,signature_file
     from employees
     where role=$1 and active=true
     order by case when $2<>'' and lower(name)=lower($2) then 0 else 1 end, name
     limit 1`,
    [role,preferredName]
  );
  return rows[0] || null;
}

export async function createExpenseRequest(employee, items) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const reviewer = await getWorkflowActorTx(client,'REVIEWER');
    const approver = await getWorkflowActorTx(client,'APPROVER');
    if (!reviewer || !approver) throw new Error('Reviewer / Approver master data is incomplete.');

    const { rows:dateRows } = await client.query(
      "select (now() at time zone 'Asia/Jakarta')::date as request_date, " +
      "to_char(now() at time zone 'Asia/Jakarta','YYYYMMDD') as compact_date"
    );
    const requestDate = dateRows[0].request_date;
    const compact = dateRows[0].compact_date;
    const { rows:counterRows } = await client.query(
      `insert into daily_counters(counter_date,last_sequence) values($1,1)
       on conflict(counter_date) do update set last_sequence=daily_counters.last_sequence+1
       returning last_sequence`, [requestDate]
    );
    const seq = Number(counterRows[0].last_sequence);
    const refNo = `ERF-${compact.slice(0,4)}-${compact.slice(4)}-${String(seq).padStart(4,'0')}`;
    const total = items.reduce((s,x)=>s+Number(x.amount),0);

    const { rows } = await client.query(
      `insert into requests(
        ref_no,request_date,requester_email,employee_name,employee_id,department,location,division,
        total,status,revision,reviewer_email,approver_email
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING_REVIEW',1,$10,$11)
      returning *`,
      [refNo,requestDate,employee.email,employee.name,employee.employee_id,employee.department,
       employee.location,employee.division,total,reviewer.email,approver.email]
    );
    const request=rows[0];
    await insertItems(client, request.id, 1, items);
    await insertAction(client,request,employee,'SUBMITTED',null,'PENDING_REVIEW','');
    await client.query('commit');
    return request;
  } catch(e) {
    await client.query('rollback'); throw e;
  } finally { client.release(); }
}

async function insertItems(client, requestId, revision, items) {
  for(let i=0;i<items.length;i++){
    const x=items[i];
    await client.query(
      `insert into request_items(request_id,revision,line_no,category,purpose,payment_date,amount,evidence_names)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [requestId,revision,i+1,x.category,x.purpose,x.paymentDate,x.amount,x.evidenceNames]
    );
  }
}

async function insertAction(client, request, actor, action, fromStatus, toStatus, reason='') {
  await client.query(
    `insert into workflow_actions(
      request_id,ref_no,revision,actor_email,actor_name,actor_role,action,from_status,to_status,reason
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [request.id,request.ref_no,request.revision,actor.email,actor.name,actor.role,action,fromStatus,toStatus,reason]
  );
}

export async function getRequestDetail(id) {
  const { rows } = await pool.query(
    `select r.*,
      req.signature_file as requestor_signature,
      rev.name as reviewer_name, rev.signature_file as reviewer_signature,
      app.name as approver_name, app.signature_file as approver_signature
     from requests r
     join employees req on req.email=r.requester_email
     join employees rev on rev.email=r.reviewer_email
     join employees app on app.email=r.approver_email
     where r.id=$1`, [id]
  );
  if(!rows[0]) return null;
  const request=rows[0];
  const items=(await pool.query(
    `select line_no,category,purpose,payment_date,amount,evidence_names
     from request_items where request_id=$1 and revision=$2 order by line_no`,
    [id,request.revision]
  )).rows;
  const actions=(await pool.query(
    `select actor_name,actor_role,action,from_status,to_status,reason,created_at
     from workflow_actions where request_id=$1 order by created_at,id`, [id]
  )).rows;
  return {request,items,actions};
}

export async function setDocumentPaths(id, formPath, evidencePath) {
  const { rows } = await pool.query(
    `update requests set form_pdf_path=coalesce($2,form_pdf_path),
       evidence_pdf_path=coalesce($3,evidence_pdf_path),updated_at=now()
     where id=$1 returning *`, [id,formPath,evidencePath]
  );
  return rows[0] || null;
}

export async function transitionRequest(id, actor, stage, decision, reason='') {
  const client=await pool.connect();
  try{
    await client.query('begin');
    const {rows}=await client.query('select * from requests where id=$1 for update',[id]);
    const request=rows[0];
    if(!request) throw Object.assign(new Error('Request not found.'),{status:404});
    const approve=String(decision).toUpperCase()==='APPROVE';
    const reject=String(decision).toUpperCase()==='REJECT';
    if(!approve&&!reject) throw Object.assign(new Error('Decision must be APPROVE or REJECT.'),{status:400});
    if(reject&&!String(reason).trim()) throw Object.assign(new Error('Rejection reason is required.'),{status:400});

    let expected,toStatus,action,ownerEmail;
    if(stage==='REVIEW'){
      expected='PENDING_REVIEW'; ownerEmail=request.reviewer_email;
      toStatus=approve?'PENDING_APPROVAL':'REVIEW_REJECTED';
      action=approve?'REVIEW_APPROVED':'REVIEW_REJECTED';
      if(actor.role!=='REVIEWER') throw Object.assign(new Error('Reviewer role required.'),{status:403});
    } else {
      expected='PENDING_APPROVAL'; ownerEmail=request.approver_email;
      toStatus=approve?'APPROVED':'APPROVAL_REJECTED';
      action=approve?'FINAL_APPROVED':'APPROVAL_REJECTED';
      if(actor.role!=='APPROVER') throw Object.assign(new Error('Approver role required.'),{status:403});
    }
    if(request.status!==expected) throw Object.assign(new Error(`Request is already ${request.status}.`),{status:409});
    if(String(ownerEmail).toLowerCase()!==String(actor.email).toLowerCase()) throw Object.assign(new Error('This request is assigned to another user.'),{status:403});

    const {rows:updated}=await client.query(
      `update requests set status=$2,last_rejection_reason=$3,updated_at=now()
       where id=$1 returning *`,
      [id,toStatus,reject?String(reason).trim():'']
    );
    const next=updated[0];
    await insertAction(client,next,actor,action,expected,toStatus,reject?String(reason).trim():'');
    await client.query('commit');
    return next;
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
}

export async function recallExpenseRequest(id, employee) {
  const client=await pool.connect();
  try{
    await client.query('begin');
    const {rows}=await client.query('select * from requests where id=$1 for update',[id]);
    const request=rows[0];
    if(!request) throw Object.assign(new Error('Request not found.'),{status:404});
    if(employee.role!=='REQUESTOR')
      throw Object.assign(new Error('Only Requestor can recall a request.'),{status:403});
    if(String(request.requester_email).toLowerCase()!==String(employee.email).toLowerCase())
      throw Object.assign(new Error('This is not your request.'),{status:403});
    if(request.status!=='PENDING_REVIEW')
      throw Object.assign(new Error('Only requests that are still Pending Review can be recalled.'),{status:409});

    const {rows:updated}=await client.query(
      `update requests set status='RECALLED',last_rejection_reason='',updated_at=now()
       where id=$1 returning *`, [id]
    );
    const next=updated[0];
    await insertAction(client,next,employee,'RECALLED','PENDING_REVIEW','RECALLED','Recalled by requestor');
    await client.query('commit');
    return next;
  }catch(e){
    await client.query('rollback');
    throw e;
  }finally{
    client.release();
  }
}

export async function reviseExpenseRequest(id, employee, items) {
  const client=await pool.connect();
  try{
    await client.query('begin');
    const {rows}=await client.query('select * from requests where id=$1 for update',[id]);
    const request=rows[0];
    if(!request) throw Object.assign(new Error('Request not found.'),{status:404});
    if(String(request.requester_email).toLowerCase()!==String(employee.email).toLowerCase())
      throw Object.assign(new Error('This is not your request.'),{status:403});
    if(!['REVIEW_REJECTED','APPROVAL_REJECTED','RECALLED'].includes(request.status))
      throw Object.assign(new Error('Only rejected or recalled requests can be revised.'),{status:409});

    const oldStatus=request.status;
    const newRevision=Number(request.revision)+1;
    const total=items.reduce((s,x)=>s+Number(x.amount),0);
    const {rows:updated}=await client.query(
      `update requests set revision=$2,total=$3,status='PENDING_REVIEW',
       last_rejection_reason='',form_pdf_path=null,evidence_pdf_path=null,updated_at=now()
       where id=$1 returning *`, [id,newRevision,total]
    );
    const next=updated[0];
    await insertItems(client,id,newRevision,items);
    await insertAction(client,next,employee,'REVISED',oldStatus,'PENDING_REVIEW','');
    await client.query('commit');
    return next;
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
}

export async function logEmail({requestId=null,refNo=null,event,to,cc='',status,error=''}) {
  await pool.query(
    `insert into email_log(request_id,ref_no,event,mail_to,mail_cc,status,error)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [requestId,refNo,event,to,cc,status,error]
  );
}
