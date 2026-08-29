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
         from requests where status='PENDING_REVIEW'
         order by updated_at asc limit 100`;
    params=[];
  } else {
    q = `select id,ref_no,request_date,employee_name,total,status,revision,last_rejection_reason,updated_at
         from requests where status='PENDING_APPROVAL'
         order by updated_at asc limit 100`;
    params=[];
  }
  const { rows } = await pool.query(q,params);
  return rows;
}

async function getWorkflowActorTx_(client, role) {
  const { rows } = await client.query(
    `select email,name,role,signature_file
     from employees where role=$1 and active=true order by name limit 1`,
    [role]
  );
  return rows[0] || null;
}

export async function createExpenseRequest(employee, items) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const reviewer = await getWorkflowActorTx_(client,'REVIEWER');
    const approver = await getWorkflowActorTx_(client,'APPROVER');
    if (!reviewer || !approver) throw new Error('Reviewer / Approver master data is incomplete.');

    const dateResult = await client.query("select (now() at time zone 'Asia/Jakarta')::date as request_date");
    const requestDate = dateResult.rows[0].request_date;

    const counter = await client.query(
      `insert into daily_counters(counter_date,last_sequence)
       values($1,1)
       on conflict(counter_date)
       do update set last_sequence=daily_counters.last_sequence+1
       returning last_sequence`,
      [requestDate]
    );
    const seq = Number(counter.rows[0].last_sequence);

    const d = new Date(requestDate + 'T00:00:00Z');
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth()+1).padStart(2,'0');
    const dd = String(d.getUTCDate()).padStart(2,'0');
    const refNo = `ERF-${yyyy}-${mm}${dd}-${String(seq).padStart(4,'0')}`;
    const total = items.reduce((s,x)=>s+Number(x.amount),0);

    const ins = await client.query(
      `insert into requests(
        ref_no,request_date,requester_email,employee_name,employee_id,
        department,location,division,total,status,revision,
        reviewer_email,approver_email
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING_REVIEW',1,$10,$11)
      returning id,ref_no,request_date,total,status,revision`,
      [refNo,requestDate,employee.email,employee.name,employee.employee_id,
       employee.department,employee.location,employee.division,total,
       reviewer.email,approver.email]
    );
    const request = ins.rows[0];

    for (let i=0;i<items.length;i++) {
      const x=items[i];
      await client.query(
        `insert into request_items(
          request_id,revision,line_no,category,purpose,payment_date,amount,evidence_names
        ) values($1,1,$2,$3,$4,$5,$6,$7)`,
        [request.id,i+1,x.category,x.purpose,x.paymentDate,x.amount,x.evidenceNames]
      );
    }

    await client.query(
      `insert into workflow_actions(
        request_id,ref_no,revision,actor_email,actor_name,actor_role,
        action,from_status,to_status,reason
      ) values($1,$2,1,$3,$4,'REQUESTOR','SUBMITTED',null,'PENDING_REVIEW','')`,
      [request.id,request.ref_no,employee.email,employee.name]
    );

    await client.query('commit');
    return request;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
