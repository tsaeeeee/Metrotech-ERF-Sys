import pg from 'pg';
import {archiveApprovedPacket} from './approval-archive.js';
const { Pool } = pg;

const databaseConfig={
  host: process.env.POSTGRES_HOST || 'db',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'metrotech_erf',
  user: process.env.POSTGRES_USER || 'metrotech_erf',
  password: process.env.POSTGRES_PASSWORD,
  max: 10
};
export const pool = new Pool(databaseConfig);

// Separate connections prevent lock waiters from starving workflow queries.
export const workflowLockPool=new Pool({...databaseConfig,max:4});

export async function pingDb() {
  const { rows } = await pool.query('select now() as now');
  return rows[0];
}

const BOOTSTRAP_ADMIN_PASSWORD_HASH='$2a$10$2veWEQJ4tvgWEnP3x6Lio.xCf675jaooACjyaZVKFVFPLReonFhpu';

export async function ensureBootstrapAdminCredentials() {
  await pool.query(
    `insert into employees(
       email,name,employee_id,department,location,division,role,
       signature_file,active,username,password_hash
     )
     values(
       'admin-dev@metrotech.local',
       'ERF Administrator',
       'ADMIN-001',
       'IT',
       'Jakarta',
       'Administration',
       'ADMIN',
       '',
       true,
       'Administrator',
       $1
     )
     on conflict(email) do update
     set name=excluded.name,
         employee_id=excluded.employee_id,
         department=excluded.department,
         location=excluded.location,
         division=excluded.division,
         role='ADMIN',
         active=true,
         username=coalesce(employees.username,excluded.username),
         password_hash=coalesce(employees.password_hash,excluded.password_hash)`,
    [BOOTSTRAP_ADMIN_PASSWORD_HASH]
  );
}

export async function listActiveEmployees() {
  const { rows } = await pool.query(
    `select email,name,employee_id,department,location,division,role,signature_file,username,must_change_password,must_upload_signature
     from employees where active=true order by
     case role when 'REQUESTOR' then 1 when 'REVIEWER' then 2 else 3 end, name`
  );
  return rows;
}

export async function getEmployee(email) {
  const { rows } = await pool.query(
    `select email,name,employee_id,department,location,division,role,signature_file,username,must_change_password,must_upload_signature
     from employees where lower(email)=lower($1) and active=true limit 1`,
    [email]
  );
  return rows[0] || null;
}

export async function authenticateLocalUser(username,password) {
  const {rows}=await pool.query(
    `select email,name,employee_id,department,location,division,role,signature_file,username,must_change_password,must_upload_signature
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

export async function changeEmployeePassword(email,currentPassword,newPassword) {
  const {rows}=await pool.query(
    `update employees
     set password_hash=crypt($3,gen_salt('bf',10)),
         must_change_password=false
     where lower(email)=lower($1)
       and active=true
       and role<>'ADMIN'
       and password_hash is not null
       and password_hash=crypt($2,password_hash)
     returning email,name,employee_id,department,location,division,role,signature_file,username,must_change_password,must_upload_signature`,
    [email,String(currentPassword||''),String(newPassword||'')]
  );
  if(!rows[0]) throw Object.assign(new Error('Current password is incorrect.'),{status:400});
  return rows[0];
}

export async function updateEmployeeSignature(email,signatureFile) {
  if(!signatureFile) throw Object.assign(new Error('Choose a signature image first.'),{status:400});
  const {rows}=await pool.query(
    `update employees
     set signature_file=$2,
         must_upload_signature=false
     where lower(email)=lower($1) and active=true
     returning email,name,employee_id,department,location,division,role,signature_file,username,must_change_password,must_upload_signature`,
    [email,signatureFile]
  );
  if(!rows[0]) throw Object.assign(new Error('Employee not found.'),{status:404});
  return rows[0];
}

export async function listManagedEmployees() {
  const {rows}=await pool.query(
    `select email,name,employee_id,department,location,division,role,active,username,must_change_password,must_upload_signature,
       (coalesce(signature_file,'')<>'') as has_signature
     from employees
     where role<>'ADMIN'
     order by active desc,name`
  );
  return rows;
}

function validateManagedRole(role){
  const next=String(role||'').trim().toUpperCase();
  if(!['NONE','REQUESTOR','REVIEWER','APPROVER'].includes(next))
    throw Object.assign(new Error('ERF Access must be No Access, Requestor, Reviewer, or Approver.'),{status:400});
  return next;
}

async function assertSingleActiveApproverTx(client,{excludeEmail=null}={}) {
  const params=[];
  let exclude='';
  if(excludeEmail){
    params.push(excludeEmail);
    exclude=' and lower(email)<>lower($1)';
  }
  const {rows}=await client.query(
    `select email,name
     from employees
     where role='APPROVER' and active=true${exclude}
     order by name`,
    params
  );
  if(rows.length)
    throw Object.assign(new Error(`Only one active Approver is allowed. Current active Approver: ${rows[0].name}.`),{status:409});
}

async function chooseReviewerTx(client,{excludeEmail=null}={}) {
  const params=[];
  let exclude='';
  if(excludeEmail){
    params.push(excludeEmail);
    exclude=' and lower(e.email)<>lower($1)';
  }
  const {rows}=await client.query(
    `select e.email,e.name,e.role,e.signature_file,
       count(r.id) filter (where r.status='PENDING_REVIEW')::int as pending_count
     from employees e
     left join requests r on lower(r.reviewer_email)=lower(e.email)
     where e.role='REVIEWER' and e.active=true${exclude}
     group by e.email,e.name,e.role,e.signature_file
     order by pending_count asc, lower(e.name) asc, lower(e.email) asc
     limit 1`,
    params
  );
  return rows[0] || null;
}

async function getSingleApproverTx(client) {
  const {rows}=await client.query(
    `select email,name,role,signature_file
     from employees
     where role='APPROVER' and active=true
     order by name`
  );
  if(rows.length!==1){
    const message=rows.length===0
      ? 'Exactly one active Approver is required before requests can be submitted.'
      : 'Multiple active Approvers found. Keep only one active Approver.';
    throw Object.assign(new Error(message),{status:409});
  }
  return rows[0];
}

async function reassignPendingReviewerTx(client,email) {
  const replacement=await chooseReviewerTx(client,{excludeEmail:email});
  const {rows:pending}=await client.query(
    `select id from requests
     where lower(reviewer_email)=lower($1) and status='PENDING_REVIEW'
     for update`,
    [email]
  );
  if(!pending.length) return {count:0,replacement:null};
  if(!replacement)
    throw Object.assign(new Error('Cannot remove this Reviewer while they still have pending reviews and no other active Reviewer is available.'),{status:409});

  const {rowCount}=await client.query(
    `update requests
     set reviewer_email=$2,updated_at=now()
     where lower(reviewer_email)=lower($1) and status='PENDING_REVIEW'`,
    [email,replacement.email]
  );
  return {count:rowCount,replacement};
}

export async function createManagedEmployee(data) {
  const role=validateManagedRole(data.role);
  const required=['name','email','username','password','employeeId','department','location','division'];
  for(const key of required){
    if(!String(data[key]||'').trim())
      throw Object.assign(new Error(`${key} is required.`),{status:400});
  }

  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(77123001)");
    if(role==='APPROVER') await assertSingleActiveApproverTx(client);

    const {rows}=await client.query(
      `insert into employees(
        email,name,employee_id,department,location,division,role,signature_file,active,username,password_hash,must_change_password,must_upload_signature
       ) values(
        lower($1),$2,$3,$4,$5,$6,$7,'',true,$8,crypt($9,gen_salt('bf',10)),true,true
       )
       returning email,name,employee_id,department,location,division,role,active,username,must_change_password,must_upload_signature,
         false as has_signature`,
      [
        String(data.email).trim(),String(data.name).trim(),String(data.employeeId).trim(),
        String(data.department).trim(),String(data.location).trim(),String(data.division).trim(),
        role,String(data.username).trim(),String(data.password)
      ]
    );
    await client.query('commit');
    return rows[0];
  }catch(e){
    await client.query('rollback');
    if(e.code==='23505') throw Object.assign(new Error('Email or username already exists.'),{status:409});
    throw e;
  }finally{
    client.release();
  }
}

export async function updateManagedEmployee(email,data) {
  const role=validateManagedRole(data.role);
  const required=['name','username','employeeId','department','location','division'];
  for(const key of required){
    if(!String(data[key]||'').trim())
      throw Object.assign(new Error(`${key} is required.`),{status:400});
  }

  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(77123001)");
    const {rows:currentRows}=await client.query(
      `select email,role,active from employees
       where lower(email)=lower($1) and role<>'ADMIN'
       for update`,
      [email]
    );
    const current=currentRows[0];
    if(!current) throw Object.assign(new Error('Managed user not found.'),{status:404});

    const nextActive=data.active!==false;
    const leavingReviewer=current.role==='REVIEWER' && (!nextActive || role!=='REVIEWER');
    const leavingApprover=current.role==='APPROVER' && (!nextActive || role!=='APPROVER');

    if(role==='APPROVER' && nextActive && (current.role!=='APPROVER' || !current.active))
      await assertSingleActiveApproverTx(client,{excludeEmail:email});

    if(leavingApprover){
      const {rows:pending}=await client.query(
        `select count(*)::int as count
         from requests
         where lower(approver_email)=lower($1) and status='PENDING_APPROVAL'`,
        [email]
      );
      if(Number(pending[0]?.count||0)>0)
        throw Object.assign(new Error('Cannot remove or change this Approver while final approvals are still pending.'),{status:409});
    }

    if(leavingReviewer) await reassignPendingReviewerTx(client,email);

    const {rows}=await client.query(
      `update employees
       set name=$2,
           employee_id=$3,
           department=$4,
           location=$5,
           division=$6,
           role=$7,
           username=$8,
           active=$9,
           password_hash=case when $10<>'' then crypt($10,gen_salt('bf',10)) else password_hash end,
           must_change_password=case when $10<>'' then true else must_change_password end
       where lower(email)=lower($1) and role<>'ADMIN'
       returning email,name,employee_id,department,location,division,role,active,username,must_change_password,must_upload_signature,
         (coalesce(signature_file,'')<>'') as has_signature`,
      [
        email,String(data.name).trim(),String(data.employeeId).trim(),String(data.department).trim(),
        String(data.location).trim(),String(data.division).trim(),role,String(data.username).trim(),
        nextActive,String(data.password||'')
      ]
    );
    await client.query('commit');
    return rows[0];
  }catch(e){
    await client.query('rollback');
    if(e.code==='23505') throw Object.assign(new Error('Username already exists.'),{status:409});
    throw e;
  }finally{
    client.release();
  }
}

export async function setManagedEmployeeActive(email,active) {
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(77123001)");
    const {rows:currentRows}=await client.query(
      `select email,role,active from employees
       where lower(email)=lower($1) and role<>'ADMIN'
       for update`,
      [email]
    );
    const current=currentRows[0];
    if(!current) throw Object.assign(new Error('Managed user not found.'),{status:404});

    const nextActive=Boolean(active);
    if(current.role==='APPROVER' && nextActive && !current.active)
      await assertSingleActiveApproverTx(client,{excludeEmail:email});

    if(current.role==='APPROVER' && !nextActive && current.active){
      const {rows:pending}=await client.query(
        `select count(*)::int as count
         from requests
         where lower(approver_email)=lower($1) and status='PENDING_APPROVAL'`,
        [email]
      );
      if(Number(pending[0]?.count||0)>0)
        throw Object.assign(new Error('Cannot remove this Approver while final approvals are still pending.'),{status:409});
    }

    if(current.role==='REVIEWER' && !nextActive && current.active)
      await reassignPendingReviewerTx(client,email);

    const {rows}=await client.query(
      `update employees
       set active=$2
       where lower(email)=lower($1) and role<>'ADMIN'
       returning email,name,employee_id,department,location,division,role,active,username,must_change_password,must_upload_signature,
         (coalesce(signature_file,'')<>'') as has_signature`,
      [email,nextActive]
    );
    await client.query('commit');
    return rows[0];
  }catch(e){
    await client.query('rollback');
    throw e;
  }finally{
    client.release();
  }
}

export async function listRequestsForEmployee(employee) {
  let q, params;
  if (employee.role === 'REQUESTOR' || employee.role === 'NONE') {
    q = `select r.id,r.ref_no,r.requester_email,r.request_date,r.employee_name,r.request_type,r.form_type,r.total,r.status,r.revision,r.last_rejection_reason,r.updated_at,
         r.reviewer_email,r.approver_email
         from requests r
         where lower(r.requester_email)=lower($1)
           and ((r.form_type='ERF' and $2::boolean) or (r.form_type='ECF' and $3::boolean))
         order by r.updated_at desc limit 100`;
    params=[employee.email,employee.role==='REQUESTOR',employee.ecfRole!=='NONE'];
  } else if (employee.role === 'REVIEWER') {
    q = `select r.id,r.ref_no,r.requester_email,r.request_date,r.employee_name,r.request_type,r.form_type,r.total,r.status,r.revision,r.last_rejection_reason,r.updated_at,
         r.reviewer_email,r.approver_email
         from requests r
         where lower(r.reviewer_email)=lower($1) and r.status='PENDING_REVIEW'
         order by r.updated_at asc limit 100`;
    params=[employee.email];
  } else if (employee.role === 'APPROVER') {
    q = `select r.id,r.ref_no,r.requester_email,r.request_date,r.employee_name,r.request_type,r.form_type,r.total,r.status,r.revision,r.last_rejection_reason,r.updated_at,
         r.reviewer_email,r.approver_email
         from requests r
         where lower(r.approver_email)=lower($1) and r.status='PENDING_APPROVAL'
         order by r.updated_at asc limit 100`;
    params=[employee.email];
  } else if (employee.role === 'ADMIN') {
    q = `select r.id,r.ref_no,r.requester_email,r.request_date,r.employee_name,r.request_type,r.form_type,r.total,r.status,r.revision,r.last_rejection_reason,r.updated_at,
         r.reviewer_email,r.approver_email
         from requests r
         order by r.updated_at desc limit 100`;
    params=[];
  } else {
    return [];
  }
  const { rows } = await pool.query(q,params);
  return rows;
}

export async function getEcfRole(email){
  const {rows}=await pool.query(
    `select ecf_role from admin_ecf_roles where lower(email)=lower($1) and active=true`,[email]
  );
  return rows[0]?.ecf_role||'NONE';
}

export async function listTasksForEmployee(employee){
  if(employee.role==='ADMIN') return [];
  const ecfRole=employee.ecfRole||await getEcfRole(employee.email);
  const {rows}=await pool.query(
    `select r.id,r.ref_no,r.requester_email,r.form_type,r.request_type,r.request_date,r.employee_name,
       r.total,r.status,r.revision,r.last_rejection_reason,r.updated_at
     from requests r
     where (r.status='PENDING_CHECK' and $2::boolean
       and lower(r.requester_email)<>lower($1))
       or (r.status='PENDING_REVIEW' and lower(r.reviewer_email)=lower($1))
       or (r.status='PENDING_APPROVAL' and lower(r.approver_email)=lower($1))
     order by r.updated_at asc limit 100`,[employee.email,ecfRole==='CHECKER']
  );
  return rows;
}

export async function listMyRequests(employee){
  const {rows}=await pool.query(
    `select r.id,r.ref_no,r.requester_email,r.request_date,r.employee_name,r.request_type,r.form_type,
       r.total,r.status,r.revision,r.last_rejection_reason,r.updated_at
     from requests r
     where lower(r.requester_email)=lower($1)
       and ((r.form_type='ERF' and $2::boolean) or (r.form_type='ECF' and $3::boolean))
     order by r.updated_at desc limit 100`,
    [employee.email,employee.role==='REQUESTOR',employee.ecfRole!=='NONE']
  );
  return rows;
}

const decisionActions={
  REVIEWER:['REVIEW_APPROVED','REVIEW_REJECTED','REVIEW_RECALLED'],
  APPROVER:['FINAL_APPROVED','APPROVAL_REJECTED','APPROVAL_RECALLED'],
  CHECKER:['CHECK_APPROVED','CHECK_REJECTED']
};

// Bind only the parameters actually used, including accounts with two roles.
function historyQuery(employee,requestId){
  const values=[employee.email];
  const predicates=[];
  const ownForms=[];
  if(employee.role==='REQUESTOR') ownForms.push('ERF');
  if(employee.ecfRole==='REQUESTOR') ownForms.push('ECF');
  if(ownForms.length){
    values.push(ownForms);
    predicates.push(`(lower(r.requester_email)=lower($1) and r.form_type=any($${values.length}::text[]))`);
  }
  const roles=[];
  if(decisionActions[employee.role]) roles.push(employee.role);
  if(employee.ecfRole==='CHECKER') roles.push('CHECKER');
  for(const role of roles){
    values.push(decisionActions[role]);
    const participated=`exists(select 1 from workflow_actions a
      where a.request_id=r.id and lower(a.actor_email)=lower($1)
        and a.action=any($${values.length}::text[]))`;
    const activeStatus={CHECKER:'PENDING_CHECK',REVIEWER:'PENDING_REVIEW',APPROVER:'PENDING_APPROVAL'}[role];
    // Pending work has its own page; historic access still works for revisions.
    if(requestId) predicates.push(participated);
    else {
      values.push(activeStatus);
      predicates.push(`(${participated} and r.status<>$${values.length})`);
    }
  }
  if(!predicates.length) return null;
  const scope='('+predicates.join(' or ')+')';
  if(requestId){
    values.push(requestId);
    return {text:`select exists(select 1 from requests r
      where r.id=$${values.length} and ${scope}) as participated`,values};
  }
  return {text:`select r.id,r.ref_no,r.requester_email,r.request_date,r.employee_name,r.request_type,r.form_type,
      r.total,r.status,r.revision,r.last_rejection_reason,r.updated_at,r.approver_email,r.reviewer_email
    from requests r where ${scope}
    order by r.updated_at desc limit 100`,values};
}

async function employeeHistoryQuery(employee,requestId){
  const ecfRole=employee.ecfRole??await getEcfRole(employee.email);
  return historyQuery({...employee,ecfRole},requestId);
}

export async function hasDecisionHistory(requestId,employee) {
  const query=await employeeHistoryQuery(employee,requestId);
  if(!query) return false;
  const {rows}=await pool.query(query.text,query.values);
  return rows[0]?.participated===true;
}

export async function listDecisionHistory(employee) {
  const query=await employeeHistoryQuery(employee);
  if(!query) return [];
  const {rows}=await pool.query(query.text,query.values);
  return rows;
}

export async function getEmsDashboard(employee){
  const scope=employee.role==='ADMIN'?'true':['REQUESTOR','NONE'].includes(employee.role)
    ? 'lower(r.requester_email)=lower($1)' : employee.role==='REVIEWER'
      ? 'lower(r.reviewer_email)=lower($1)' : 'lower(r.approver_email)=lower($1)';
  const formScope=employee.ecfRole==='NONE' && employee.role==='NONE'?'false':
    employee.role==='NONE'?"r.form_type='ECF'":
    employee.role==='REQUESTOR' && employee.ecfRole==='NONE'?"r.form_type='ERF'":
    "(r.form_type='ECF' or r.request_type='EXPENSE')";
  const args=employee.role==='ADMIN'?[]:[employee.email];
  const [totals,trend,categories]=await Promise.all([
    pool.query(`select r.form_type,r.status,count(*)::integer as count,
       coalesce(sum(r.total),0) as amount from requests r where ${scope}
       and ${formScope}
       group by r.form_type,r.status`,args),
    pool.query(`select to_char(r.request_date,'YYYY-MM') as month,r.form_type,
       sum(r.total) as amount,count(*)::integer as count from requests r
       where ${scope} and ${formScope} and r.status='APPROVED'
         and r.request_date>=date_trunc('month',current_date)-interval '5 months'
       group by month,r.form_type order by month,r.form_type`,args),
    pool.query(`select i.category,r.form_type,sum(i.amount) as amount
       from requests r join request_items i on i.request_id=r.id and i.revision=r.revision
       where ${scope} and ${formScope} and r.status='APPROVED'
         and r.request_date>=date_trunc('month',current_date)
       group by i.category,r.form_type order by amount desc limit 8`,args)
  ]);
  return {totals:totals.rows,trend:trend.rows,categories:categories.rows};
}

export async function createExpenseRequest(employee, items, timezone='Asia/Jakarta', requestType='EXPENSE') {
  const normalizedType=String(requestType||'EXPENSE').trim().toUpperCase();
  if(normalizedType!=='EXPENSE')
    throw Object.assign(new Error('Use Expense Claim (ECF) for claims.'),{status:400});

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(77123002)");
    const reviewer = await chooseReviewerTx(client);
    if(!reviewer)
      throw Object.assign(new Error('At least one active Reviewer is required before requests can be submitted.'),{status:409});
    const approver = await getSingleApproverTx(client);

    const { rows:dateRows } = await client.query(
      "select timezone($1,now())::date as request_date, " +
      "to_char(timezone($1,now()),'YYYYMMDD') as compact_date",
      [String(timezone||'Asia/Jakarta')]
    );
    const requestDate = dateRows[0].request_date;
    const compact = dateRows[0].compact_date;
    const { rows:counterRows } = await client.query(
      `insert into daily_counters(counter_date,request_type,last_sequence) values($1,$2,1)
       on conflict(counter_date,request_type) do update set last_sequence=daily_counters.last_sequence+1
       returning last_sequence`, [requestDate,normalizedType]
    );
    const seq = Number(counterRows[0].last_sequence);
    const refNo = `ERF-${compact.slice(0,4)}-${compact.slice(4)}-${String(seq).padStart(4,'0')}`;
    const total = items.reduce((s,x)=>s+Number(x.amount),0);

    const { rows } = await client.query(
      `insert into requests(
        ref_no,request_date,requester_email,employee_name,employee_id,department,location,division,
        request_type,total,status,revision,reviewer_email,approver_email
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_REVIEW',1,$11,$12)
      returning *`,
      [refNo,requestDate,employee.email,employee.name,employee.employee_id,employee.department,
       employee.location,employee.division,normalizedType,total,reviewer.email,approver.email]
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

export async function createEcfClaim(employee,items,timezone='Asia/Jakarta',serviceOrderNumber=''){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const role=(await client.query(
      `select ecf_role from admin_ecf_roles where lower(email)=lower($1) and active=true`,[employee.email]
    )).rows[0]?.ecf_role;
    if(role!=='REQUESTOR') throw Object.assign(new Error('ECF Requestor access is required.'),{status:403});
    const total=items.reduce((sum,x)=>sum+Number(x.amount),0);
    if(!Number.isSafeInteger(total)||total<=0)
      throw Object.assign(new Error('Claim total must be a positive whole number.'),{status:400});
    const checker=(await client.query(
      `select e.email,e.name from admin_ecf_roles a join employees e on e.email=a.email
       where a.ecf_role='CHECKER' and a.active=true limit 1`
    )).rows[0];
    if(!checker) throw Object.assign(new Error('Assign an active ECF Checker before submitting claims.'),{status:409});
    if(checker.email.toLowerCase()===employee.email.toLowerCase())
      throw Object.assign(new Error('The ECF Checker cannot check their own claim.'),{status:409});
    const profile=(await client.query(
      `select * from employee_payment_profiles where lower(employee_email)=lower($1)`,[employee.email]
    )).rows[0];
    if(!profile?.payment_to||!profile?.bank_name||!profile?.bank_code||!profile?.account_number)
      throw Object.assign(new Error('Complete payment information in My Profile first.'),{status:409});
    const reviewer=await chooseReviewerTx(client);
    if(!reviewer) throw Object.assign(new Error('An active Reviewer is required.'),{status:409});
    const approver=await getSingleApproverTx(client);
    const date=(await client.query(
      `select timezone($1,now())::date as day,to_char(timezone($1,now()),'YYYYMMDD') as compact`,
      [timezone]
    )).rows[0];
    const seq=(await client.query(
      `insert into daily_counters(counter_date,request_type,last_sequence) values($1,'ECF',1)
       on conflict(counter_date,request_type) do update set last_sequence=daily_counters.last_sequence+1
       returning last_sequence`,[date.day]
    )).rows[0].last_sequence;
    const refNo=`ECF-${date.compact.slice(0,4)}-${date.compact.slice(4)}-${String(seq).padStart(4,'0')}`;
    const request=(await client.query(
      `insert into requests(ref_no,request_date,requester_email,employee_name,employee_id,department,
       location,division,request_type,form_type,total,status,revision,reviewer_email,approver_email)
       values($1,$2,$3,$4,$5,$6,$7,$8,'EXPENSE','ECF',$9,'PENDING_CHECK',1,$10,$11) returning *`,
      [refNo,date.day,employee.email,employee.name,employee.employee_id,employee.department,
       employee.location,employee.division,total,reviewer.email,approver.email]
    )).rows[0];
    await client.query(
      `insert into ecf_details(request_id,service_order_number,payment_to,bank_name,
       bank_code,account_number,checker_email,checker_name)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [request.id,serviceOrderNumber||'-',profile.payment_to,profile.bank_name,
       profile.bank_code,profile.account_number,checker.email,checker.name]
    );
    await insertItems(client,request.id,1,items);
    await insertAction(client,request,employee,'SUBMITTED',null,'PENDING_CHECK');
    await client.query('commit');
    return request;
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
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

async function insertAction(client, request, actor, action, fromStatus, toStatus, reason='', actorRole=actor.role) {
  await client.query(
    `insert into workflow_actions(
      request_id,ref_no,revision,actor_email,actor_name,actor_role,action,from_status,to_status,reason
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [request.id,request.ref_no,request.revision,actor.email,actor.name,actorRole,action,fromStatus,toStatus,reason]
  );
}

export async function getRequestDetail(id) {
  const { rows } = await pool.query(
    `select r.*,
      req.signature_file as requestor_signature,
      rev.name as reviewer_name, rev.signature_file as reviewer_signature,
      app.name as approver_name, app.signature_file as approver_signature,
      d.service_order_number,d.payment_to,d.bank_name,d.bank_code,
      d.account_number,d.checker_email,d.checker_name,
      checker.signature_file as checker_signature
     from requests r
     join employees req on req.email=r.requester_email
     join employees rev on rev.email=r.reviewer_email
     join employees app on app.email=r.approver_email
     left join ecf_details d on d.request_id=r.id
     left join employees checker on checker.email=d.checker_email
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
    `select revision,actor_name,actor_role,action,from_status,to_status,reason,created_at
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
    if(stage==='CHECK'){
      if(request.form_type!=='ECF') throw Object.assign(new Error('Only ECF has a Checker stage.'),{status:400});
      const {rows:checks}=await client.query('select checker_email from ecf_details where request_id=$1',[id]);
      expected='PENDING_CHECK'; ownerEmail=checks[0]?.checker_email;
      toStatus=approve?'PENDING_REVIEW':'CHECK_REJECTED';
      action=approve?'CHECK_APPROVED':'CHECK_REJECTED';
      if(String(actor.email).toLowerCase()===String(request.requester_email).toLowerCase())
        throw Object.assign(new Error('You cannot check your own claim.'),{status:403});
      const role=(await client.query(
        `select ecf_role from admin_ecf_roles where lower(email)=lower($1) and active=true`,[actor.email]
      )).rows[0]?.ecf_role;
      if(role!=='CHECKER') throw Object.assign(new Error('ECF Checker access is required.'),{status:403});
      if(String(ownerEmail).toLowerCase()!==String(actor.email).toLowerCase()){
        await client.query(
          `update ecf_details set checker_email=$2,checker_name=$3,updated_at=now()
           where request_id=$1`,[id,actor.email,actor.name]
        );
        ownerEmail=actor.email;
      }
    } else if(stage==='REVIEW'){
      expected='PENDING_REVIEW'; ownerEmail=request.reviewer_email;
      toStatus=approve?'PENDING_APPROVAL':'REVIEW_REJECTED';
      action=approve?'REVIEW_APPROVED':'REVIEW_REJECTED';
      if(actor.role!=='REVIEWER') throw Object.assign(new Error('Reviewer role required.'),{status:403});
    } else if(stage==='APPROVAL'){
      expected='PENDING_APPROVAL'; ownerEmail=request.approver_email;
      toStatus=approve?'APPROVED':'APPROVAL_REJECTED';
      action=approve?'FINAL_APPROVED':'APPROVAL_REJECTED';
      if(actor.role!=='APPROVER') throw Object.assign(new Error('Approver role required.'),{status:403});
    } else {
      throw Object.assign(new Error('Invalid workflow stage.'),{status:400});
    }
    if(request.status!==expected) throw Object.assign(new Error(`Request is already ${request.status}.`),{status:409});
    if(String(ownerEmail).toLowerCase()!==String(actor.email).toLowerCase()) throw Object.assign(new Error('This request is assigned to another user.'),{status:403});

    const {rows:updated}=await client.query(
      `update requests set status=$2,last_rejection_reason=$3,updated_at=now()
       where id=$1 returning *`,
      [id,toStatus,reject?String(reason).trim():'']
    );
    const next=updated[0];
    await insertAction(
      client,next,actor,action,expected,toStatus,reject?String(reason).trim():'',
      stage==='CHECK'?'CHECKER':undefined
    );
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
    if(request.form_type==='ECF'
      ? !['REQUESTOR','NONE'].includes(employee.role)
      : employee.role!=='REQUESTOR')
      throw Object.assign(new Error('Only Requestor can recall a request.'),{status:403});
    if(String(request.requester_email).toLowerCase()!==String(employee.email).toLowerCase())
      throw Object.assign(new Error('This is not your request.'),{status:403});
    const expected=request.form_type==='ECF'?'PENDING_CHECK':'PENDING_REVIEW';
    if(request.status!==expected)
      throw Object.assign(new Error(`Only requests that are still ${expected} can be recalled.`),{status:409});

    const {rows:updated}=await client.query(
      `update requests set status='RECALLED',last_rejection_reason='',updated_at=now()
       where id=$1 returning *`, [id]
    );
    const next=updated[0];
    await insertAction(client,next,employee,'RECALLED',expected,'RECALLED','Recalled by requestor');
    await client.query('commit');
    return next;
  }catch(e){
    await client.query('rollback');
    throw e;
  }finally{
    client.release();
  }
}

export async function recallReviewedExpenseRequest(id,employee,reason){
  if(employee.role!=='REVIEWER')
    throw Object.assign(new Error('Only the assigned Reviewer can recall a reviewed request.'),{status:403});
  const note=String(reason||'').trim();
  if(!note) throw Object.assign(new Error('A recall reason is required.'),{status:400});
  const client=await pool.connect();
  try{
    await client.query('begin');
    const {rows}=await client.query('select * from requests where id=$1 for update',[id]);
    const request=rows[0];
    if(!request) throw Object.assign(new Error('Request not found.'),{status:404});
    if(request.form_type!=='ERF') throw Object.assign(new Error('Decision recall is available for ERF requests only.'),{status:403});
    if(String(request.reviewer_email).toLowerCase()!==String(employee.email).toLowerCase())
      throw Object.assign(new Error('This request is assigned to another Reviewer.'),{status:403});
    if(request.status!=='PENDING_APPROVAL')
      throw Object.assign(new Error('Reviewer can recall only while the request is Pending Approval.'),{status:409});
    const {rows:updated}=await client.query(
      `update requests set status='RECALLED',last_rejection_reason=$2,
       form_pdf_path=null,updated_at=now() where id=$1 returning *`,[id,note]
    );
    const next=updated[0];
    await insertAction(client,next,employee,'REVIEW_RECALLED','PENDING_APPROVAL','RECALLED',note);
    await client.query('commit');
    return next;
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
}

export async function recallApprovedExpenseRequest(id,employee,reason){
  if(employee.role!=='APPROVER')
    throw Object.assign(new Error('Only the assigned Approver can recall an approved request.'),{status:403});
  const note=String(reason||'').trim();
  if(!note) throw Object.assign(new Error('A recall reason is required.'),{status:400});
  const client=await pool.connect();
  try{
    await client.query('begin');
    const {rows}=await client.query('select * from requests where id=$1 for update',[id]);
    const request=rows[0];
    if(!request) throw Object.assign(new Error('Request not found.'),{status:404});
    if(request.form_type!=='ERF') throw Object.assign(new Error('Decision recall is available for ERF requests only.'),{status:403});
    if(String(request.approver_email).toLowerCase()!==String(employee.email).toLowerCase())
      throw Object.assign(new Error('This request is assigned to another Approver.'),{status:403});
    if(request.status!=='APPROVED')
      throw Object.assign(new Error('Only Approved requests can have their approval recalled.'),{status:409});
    // Archive successfully before changing status. Failure leaves approval intact.
    await archiveApprovedPacket(request);
    const {rows:updated}=await client.query(
      `update requests set status='RECALLED',last_rejection_reason=$2,
       form_pdf_path=null,updated_at=now() where id=$1 returning *`,[id,note]
    );
    const next=updated[0];
    await insertAction(client,next,employee,'APPROVAL_RECALLED','APPROVED','RECALLED',note);
    await client.query('commit');
    return next;
  }catch(e){await client.query('rollback');throw e}finally{client.release()}
}

export async function reviseExpenseRequest(id, employee, items, {serviceOrderNumber}={}) {
  const client=await pool.connect();
  try{
    await client.query('begin');
    const {rows}=await client.query('select * from requests where id=$1 for update',[id]);
    const request=rows[0];
    if(!request) throw Object.assign(new Error('Request not found.'),{status:404});
    if(String(request.requester_email).toLowerCase()!==String(employee.email).toLowerCase())
      throw Object.assign(new Error('This is not your request.'),{status:403});
    if(!['CHECK_REJECTED','REVIEW_REJECTED','APPROVAL_REJECTED','RECALLED'].includes(request.status))
      throw Object.assign(new Error('Only rejected or recalled requests can be revised.'),{status:409});

    const oldStatus=request.status;
    const newRevision=Number(request.revision)+1;
    const total=items.reduce((s,x)=>s+Number(x.amount),0);
    if(request.form_type==='ECF' && (!Number.isSafeInteger(total)||total<=0))
      throw Object.assign(new Error('Claim total must be a positive whole number.'),{status:400});

    const {rows:reviewerRows}=await client.query(
      `select email from employees
       where lower(email)=lower($1) and role='REVIEWER' and active=true
       limit 1`,
      [request.reviewer_email]
    );
    let reviewerEmail=request.reviewer_email;
    if(!reviewerRows[0]){
      await client.query("select pg_advisory_xact_lock(77123002)");
      const replacement=await chooseReviewerTx(client);
      if(!replacement)
        throw Object.assign(new Error('No active Reviewer is available for this revision.'),{status:409});
      reviewerEmail=replacement.email;
    }

    const {rows:updated}=await client.query(
      `update requests set revision=$2,total=$3,status=$5,
       reviewer_email=$4,last_rejection_reason='',form_pdf_path=null,evidence_pdf_path=null,updated_at=now()
       where id=$1 returning *`, [id,newRevision,total,reviewerEmail,request.form_type==='ECF'?'PENDING_CHECK':'PENDING_REVIEW']
    );
    const next=updated[0];
    if(request.form_type==='ECF' && serviceOrderNumber!==undefined){
      await client.query(
        `update ecf_details set service_order_number=$2,updated_at=now() where request_id=$1`,
        [id,String(serviceOrderNumber||'').trim().slice(0,100)||'-']
      );
    }
    await insertItems(client,id,newRevision,items);
    await insertAction(client,next,employee,'REVISED',oldStatus,next.status,'');
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
