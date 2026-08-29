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
    `select email,name,employee_id,department,location,division,role,signature_file
     from employees where active=true order by
     case role when 'REQUESTOR' then 1 when 'REVIEWER' then 2 else 3 end, name`
  );
  return rows;
}

export async function getEmployee(email) {
  const { rows } = await pool.query(
    `select email,name,employee_id,department,location,division,role,signature_file
     from employees where lower(email)=lower($1) and active=true limit 1`,
    [email]
  );
  return rows[0] || null;
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
         from requests where status in ('PENDING_REVIEW','REVIEW_REJECTED')
         order by updated_at asc limit 100`;
    params=[];
  } else {
    q = `select id,ref_no,request_date,employee_name,total,status,revision,last_rejection_reason,updated_at
         from requests where status in ('PENDING_APPROVAL','APPROVAL_REJECTED','APPROVED')
         order by updated_at asc limit 100`;
    params=[];
  }
  const { rows } = await pool.query(q,params);
  return rows;
}
