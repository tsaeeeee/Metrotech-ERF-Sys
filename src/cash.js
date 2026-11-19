import {CASH_CATEGORIES,entryInput,inspectSnapshot,fail,text,amount} from './cash-model.js';
import {backupCash,backupStatus,startCashBackupScheduler} from './cash-sheets.js';

const uuid=value=>{if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(value)))fail('Invalid record ID.');return value;};
export async function cashAccess(client,email){
  return (await client.query('select access from cash_access where lower(employee_email)=lower($1)',[email])).rows[0]?.access||'NONE';
}
export async function saveCashAccess(client,email,access,actor){
  if(!['NONE','VIEW','MANAGE'].includes(access))fail('Choose a valid Cash Tracker access level.');
  const found=(await client.query('select email from employees where lower(email)=lower($1)',[email])).rows[0];
  if(!found)fail('Employee not found.',404);
  const before=await cashAccess(client,found.email);
  await client.query(`insert into cash_access(employee_email,access,updated_by) values($1,$2,$3)
    on conflict(employee_email) do update set access=$2,updated_by=$3,updated_at=now()`,[found.email,access,actor]);
  await audit(client,actor,'ACCESS_CHANGED',null,'',{email:found.email,access:before},{email:found.email,access});
}
async function audit(client,actor,action,id,reason,before,after){
  await client.query('insert into cash_audit(actor_email,action,entry_id,reason,before_data,after_data) values($1,$2,$3,$4,$5,$6)',[actor,action,id,reason,before,after]);
}
async function transaction(pool,handler){
  const client=await pool.connect();try{await client.query('begin');const result=await handler(client);await client.query('commit');return result}
  catch(e){await client.query('rollback');throw e}finally{client.release()}
}
async function requireCashWrite(client,email){
  const row=(await client.query('select access from cash_access where lower(employee_email)=lower($1) for share',[email])).rows[0];
  if(row?.access!=='MANAGE')fail('Cash Tracker manage access required.',403);
}
export async function importCashSnapshot(client,snapshot,actor){
  const report=inspectSnapshot(snapshot);
  await client.query('select pg_advisory_xact_lock(77123020)');
  const done=(await client.query("select id,checksum,report from cash_imports where source_document=$1 and state='IMPORTED'",[report.source])).rows[0];
  if(done){if(done.checksum!==report.checksum)fail('This workbook has already been imported from another snapshot. Review changes before importing again.',409);return {id:done.id,report:done.report,alreadyImported:true};}
  const batch=(await client.query(`insert into cash_imports(source_document,checksum,snapshot,report,created_by) values($1,$2,$3,$4,$5)
    on conflict(checksum) do update set checksum=excluded.checksum returning id`,[report.source,report.checksum,snapshot,{...report,sheets:report.sheets.map(({entries,...s})=>({...s,count:entries.length}))},actor])).rows[0];
  for(const sheet of report.sheets){
    if(!sheet.entries.length)continue;
    const book=(await client.query('insert into cash_books(label,year,source_document,source_sheet,created_by) values($1,$2,$3,$4,$5) returning id',[sheet.title,Number(sheet.title),report.source,sheet.sheetId,actor])).rows[0];
    for(const e of sheet.entries)await client.query(`insert into cash_entries(book_id,entry_date,category,activity,notes,income,outcome,kind,origin,source_row,import_id,created_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,'LEGACY',$9,$10,$11)`,[book.id,e.entry_date,e.category,e.activity,e.notes,e.income,e.outcome,e.kind,e.source_row,batch.id,actor]);
    const actual=(await client.query('select count(*)::int n,sum(income)::text income,sum(outcome)::text outcome from cash_entries where book_id=$1',[book.id])).rows[0];
    if(actual.n!==sheet.entries.length||actual.income!==sheet.income||actual.outcome!==sheet.outcome)throw new Error('Import reconciliation failed.');
  }
  await client.query("update cash_imports set state='IMPORTED',imported_at=now() where id=$1",[batch.id]);
  await audit(client,actor,'LEGACY_IMPORTED',null,'',null,{batch:batch.id,checksum:report.checksum,count:report.count});
  return {id:batch.id,count:report.count,alreadyImported:false};
}

export function installCashRoutes(app,{pool,requireUser,requireAdmin,upload}){
  const route=fn=>async(req,res,next)=>{try{await fn(req,res)}catch(e){next(e)}};
  const permit=manage=>async(req,res,next)=>{try{
    const grant=await cashAccess(pool,req.employee.email);
    if(grant==='NONE'||manage&&grant!=='MANAGE')fail('Cash Tracker access required.',403);next();
  }catch(e){next(e)}};
  app.use(['/api/cash','/api/admin/cash'],(_req,res,next)=>{res.set('Cache-Control','private, no-store');next()});
  app.get('/api/cash/access',requireUser,route(async(req,res)=>res.json({access:await cashAccess(pool,req.employee.email)})));
  app.get('/api/cash/books',requireUser,permit(false),route(async(req,res)=>{
    const books=(await pool.query('select id,label,year,opening_balance::text from cash_books order by year desc,created_at desc')).rows;
    const cats=(await pool.query('select distinct category from cash_entries order by category')).rows.map(r=>r.category);
    res.json({books,categories:[...new Set([...CASH_CATEGORIES,...cats])]});
  }));
  app.get('/api/cash/overview',requireUser,permit(false),route(async(req,res)=>{
    const bookId=uuid(req.query.book);const book=(await pool.query('select * from cash_books where id=$1',[bookId])).rows[0];if(!book)fail('Cash book not found.',404);
    const totals=(await pool.query(`select count(*)::int count,
      (coalesce(sum(income-outcome) filter(where kind='OPENING'),0)+$2::numeric)::text opening,
      coalesce(sum(income) filter(where kind<>'OPENING'),0)::text income,
      coalesce(sum(outcome) filter(where kind<>'OPENING'),0)::text outcome,
      (coalesce(sum(income-outcome),0)+$2::numeric)::text balance from cash_entries where book_id=$1 and not voided`,[bookId,book.opening_balance])).rows[0];
    const trend=(await pool.query(`select to_char(entry_date,'YYYY-MM') as month,sum(income)::text income,sum(outcome)::text outcome from cash_entries where book_id=$1 and not voided and kind<>'OPENING' group by 1 order by 1`,[bookId])).rows;
    const categories=(await pool.query(`select category,sum(outcome)::text amount from cash_entries where book_id=$1 and not voided and outcome>0 group by category order by sum(outcome) desc`,[bookId])).rows;
    res.json({book,totals,trend,categories});
  }));
  app.get('/api/cash/entries',requireUser,permit(false),route(async(req,res)=>{
    const bookId=uuid(req.query.book),offset=Number(req.query.offset||0),query=text(req.query.q,200),category=text(req.query.category,120);
    if(!Number.isSafeInteger(offset)||offset<0)fail('Invalid page.');
    const args=[bookId,query,category];const where="($2='' or concat_ws(' ',activity,category,notes) ilike '%'||$2||'%') and ($3='' or category=$3)";
    const total=(await pool.query(`select count(*)::int total from cash_entries where book_id=$1 and ${where}`,args)).rows[0].total;
    const rows=(await pool.query(`with ledger as(select e.*,e.entry_date::text date,
      b.opening_balance+sum(case when voided then 0 else income-outcome end) over(order by e.entry_date,e.created_at,e.source_row nulls last,e.id) as balance
      from cash_entries e join cash_books b on b.id=e.book_id where book_id=$1)
      select * from ledger where ${where} order by entry_date desc,created_at desc,source_row desc nulls first,id desc limit 50 offset $4`,[...args,offset])).rows;
    res.json({entries:rows,total,offset,limit:50});
  }));
  app.get('/api/cash/log',requireUser,permit(false),route(async(req,res)=>{
    const offset=Number(req.query.offset||0);
    if(!Number.isSafeInteger(offset)||offset<0)fail('Invalid page.');
    const where="a.action in ('CREATED','VOIDED','LEGACY_IMPORTED','BOOK_CREATED')";
    const total=(await pool.query(`select count(*)::int total from cash_audit a where ${where}`)).rows[0].total;
    const logs=(await pool.query(`select a.id::text,a.action,a.entry_id,a.reason,a.created_at,a.actor_email,
      coalesce(nullif(u.name,''),a.actor_email) actor_name,
      coalesce(e.activity,'') activity,coalesce(b.label,a.after_data->>'label','') book,
      case when a.action='LEGACY_IMPORTED' then a.after_data->>'count' end imported_count,
      case when a.action='LEGACY_IMPORTED' then a.after_data->>'batch' end import_id,
      coalesce(a.entry_id::text,a.after_data->>'batch',a.after_data->>'id') record_id
      from cash_audit a left join employees u on lower(u.email)=lower(a.actor_email)
      left join cash_entries e on e.id=a.entry_id left join cash_books b on b.id=e.book_id
      where ${where} order by a.created_at desc,a.id desc limit 50 offset $1`,[offset])).rows;
    res.json({logs,total,offset,limit:50});
  }));
  app.get('/api/cash/entries/:id/audit',requireUser,permit(false),route(async(req,res)=>{
    const entry=(await pool.query(`select e.*,coalesce(nullif(u.name,''),e.created_by) creator_name from cash_entries e left join employees u on lower(u.email)=lower(e.created_by) where e.id=$1`,[uuid(req.params.id)])).rows[0];if(!entry)fail('Entry not found.',404);
    res.json({entry,audit:(await pool.query(`select a.*,coalesce(nullif(u.name,''),a.actor_email) actor_name from cash_audit a left join employees u on lower(u.email)=lower(a.actor_email) where a.entry_id=$1 order by a.created_at desc,a.id desc`,[entry.id])).rows});
  }));
  app.post('/api/cash/entries',requireUser,permit(true),route(async(req,res)=>{
    const value=entryInput(req.body),bookId=uuid(req.body.book_id),id=uuid(req.body.id);
    const result=await transaction(pool,async client=>{
      await requireCashWrite(client,req.employee.email);
      const book=(await client.query('select year from cash_books where id=$1 for share',[bookId])).rows[0];
      if(!book||Number(value.entry_date.slice(0,4))!==book.year)fail('Choose a cash book matching the transaction year.');
      const row=(await client.query('insert into cash_entries(id,book_id,entry_date,category,activity,notes,income,outcome,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(id) do nothing returning *',[id,bookId,value.entry_date,value.category,value.activity,value.notes,value.income,value.outcome,req.employee.email])).rows[0];
      if(!row){
        const previous=(await client.query('select *,entry_date::text date from cash_entries where id=$1',[id])).rows[0];
        if(!previous||previous.created_by!==req.employee.email||previous.book_id!==bookId||previous.date!==value.entry_date||previous.origin!=='EMS'||['category','activity','notes','income','outcome'].some(key=>previous[key]!==value[key]))fail('This entry ID was already used with different details.',409);
        return previous;
      }
      await audit(client,req.employee.email,'CREATED',row.id,'',null,row);return row;
    });res.status(201).json(result);
  }));
  app.post('/api/cash/entries/:id/void',requireUser,permit(true),route(async(req,res)=>{
    const reason=text(req.body.reason);if(!reason)fail('A correction reason is required.');
    const result=await transaction(pool,async client=>{
      await requireCashWrite(client,req.employee.email);
      const before=(await client.query('select * from cash_entries where id=$1 for update',[uuid(req.params.id)])).rows[0];
      if(!before)fail('Entry not found.',404);
      if(before.voided||before.version!==req.body.version)fail('Entry changed. Refresh before correcting.',409);
      const row=(await client.query('update cash_entries set voided=true,version=version+1,updated_at=now() where id=$1 returning *',[before.id])).rows[0];
      await audit(client,req.employee.email,'VOIDED',row.id,reason,before,row);return row;
    });res.json(result);
  }));
  app.get('/api/admin/cash/access',requireUser,requireAdmin,route(async(req,res)=>res.json({users:(await pool.query("select e.email,e.name,e.active,coalesce(c.access,'NONE') access from employees e left join cash_access c on c.employee_email=e.email order by e.name")).rows})));
  app.put('/api/admin/cash/access',requireUser,requireAdmin,route(async(req,res)=>{
    await transaction(pool,async client=>{await client.query('select pg_advisory_xact_lock(77123021)');await saveCashAccess(client,req.body.email,req.body.access,req.employee.email)});res.json({ok:true});
  }));
  app.post('/api/admin/cash/books',requireUser,requireAdmin,route(async(req,res)=>{
    const year=Number(req.body.year),label=text(req.body.label,100),opening=amount(req.body.opening_balance||'0');
    if(!Number.isInteger(year)||year<2000||year>2099||!label)fail('Enter a name and valid year.');
    const result=await transaction(pool,async client=>{
      const book=(await client.query('insert into cash_books(label,year,opening_balance,created_by) values($1,$2,$3,$4) returning *',[label,year,opening,req.employee.email])).rows[0];
      await audit(client,req.employee.email,'BOOK_CREATED',null,'',null,book);return book;
    });res.status(201).json(result);
  }));
  app.post('/api/admin/cash/import/preview',requireUser,requireAdmin,upload.single('snapshot'),route(async(req,res)=>{
    if(!req.file||req.file.size>10*1024*1024)fail('Choose a snapshot JSON up to 10 MB.');
    let snapshot;try{snapshot=JSON.parse(req.file.buffer.toString('utf8'))}catch{fail('Invalid JSON snapshot.')}
    const raw=inspectSnapshot(snapshot),report={...raw,sheets:raw.sheets.map(({entries,...s})=>({...s,count:entries.length}))};
    const row=(await pool.query(`insert into cash_imports(source_document,checksum,snapshot,report,created_by) values($1,$2,$3,$4,$5)
      on conflict(checksum) do update set checksum=excluded.checksum returning id,state`,[raw.source,raw.checksum,snapshot,report,req.employee.email])).rows[0];res.json({...row,report});
  }));
  app.post('/api/admin/cash/import/:id/commit',requireUser,requireAdmin,route(async(req,res)=>{
    const batch=(await pool.query('select * from cash_imports where id=$1',[uuid(req.params.id)])).rows[0];if(!batch)fail('Import preview not found.',404);
    if(req.body.checksum!==batch.checksum||req.body.confirm!==true)fail('Review and confirm the import preview.');
    res.json(await transaction(pool,client=>importCashSnapshot(client,batch.snapshot,req.employee.email)));
  }));
  app.get('/api/admin/cash/backup',requireUser,requireAdmin,route(async(req,res)=>res.json(await backupStatus(pool))));
  app.put('/api/admin/cash/backup',requireUser,requireAdmin,route(async(req,res)=>{
    const sheet=text(req.body.spreadsheet_id,150),hour=Number(req.body.hour_wib);
    if(!/^[-\w]{20,150}$/.test(sheet)||!Number.isInteger(hour)||hour<0||hour>23||typeof req.body.enabled!=='boolean')fail('Enter a spreadsheet ID and backup hour (WIB).');
    if(req.body.enabled&&!process.env.CASH_GOOGLE_KEY_FILE)fail('Configure the Google backup credential on the server first.',409);
    await transaction(pool,async client=>{
      const before=(await client.query('select * from cash_backup_settings where id=1 for update')).rows[0];
      await client.query('update cash_backup_settings set spreadsheet_id=$1,enabled=$2,hour_wib=$3,updated_by=$4,updated_at=now() where id=1',[sheet,req.body.enabled,hour,req.employee.email]);
      await audit(client,req.employee.email,'BACKUP_SETTINGS',null,'',before,{spreadsheet_id:sheet,enabled:req.body.enabled,hour_wib:hour});
    });res.json(await backupStatus(pool));
  }));
  app.post('/api/admin/cash/backup/run',requireUser,requireAdmin,route(async(req,res)=>res.json(await backupCash(pool,{manual:true}))));
  if(process.env.EMS_STAGING!=='true')startCashBackupScheduler(pool);
}
