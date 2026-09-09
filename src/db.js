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
