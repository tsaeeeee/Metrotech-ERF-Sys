import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {hasRole,sameEmail} from './access.js';
import {submissionOptions,pendingRecipients} from './workflow-policy.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mime=new Set(['application/pdf','image/png','image/jpeg','image/jpg']);
const text=(value,max)=>{const s=String(value??'');if(s.length>max)fail('Draft field is too long.');return s};

// The JSON manifest is the commit point. Evidence is written first, then a rename
// publishes the new version. All readers/writers use the same advisory lock.
export class DraftStore{
  constructor(root){this.root=path.join(root,'drafts')}
  owner(email){return path.join(this.root,createHash('sha256').update(email.toLowerCase()).digest('hex'))}
  dir(email,id){if(!uuid.test(id))fail('Draft not found.',404);return path.join(this.owner(email),id)}
  async read(email,id){
    try{return JSON.parse(await fs.readFile(path.join(this.dir(email,id),'draft.json'),'utf8'))}
    catch(e){if(e.code==='ENOENT')fail('Draft not found.',404);throw e}
  }
  async list(email){
    const names=await fs.readdir(this.owner(email)).catch(e=>{if(e.code==='ENOENT')return [];throw e});
    const rows=[];
    for(const id of names.filter(n=>uuid.test(n))){
      try{const draft=await this.read(email,id);if(!draft.submitted)rows.push(draft)}
      catch(e){if(e.status!==404)throw e}
    }
    return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
  async manifest(email,draft){
    const dir=this.dir(email,draft.id);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const temp=path.join(dir,`${randomUUID()}.tmp`);
    const handle=await fs.open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(draft));await handle.sync()}finally{await handle.close()}
    await fs.rename(temp,path.join(dir,'draft.json'));
    const directory=await fs.open(dir,'r');try{await directory.sync()}finally{await directory.close()}
  }
  async save(email,previous,payload,files){
    const now=new Date().toISOString();
    const draft={id:previous?.id||randomUUID(),version:(previous?.version||0)+1,
      createdAt:previous?.createdAt||now,updatedAt:now,formType:payload.formType,payload,files:[]};
    const dir=this.dir(email,draft.id);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    try{
      for(const file of files){
        const id=randomUUID();
        const handle=await fs.open(path.join(dir,id),'wx',0o600);
        try{await handle.writeFile(file.buffer);await handle.sync()}finally{await handle.close()}
        draft.files.push({id,name:file.originalname,type:file.mimetype,size:file.size,field:file.fieldname});
      }
      await this.manifest(email,draft);
    }catch(e){throw e} // Leave orphan files for the next save; a rename may already have committed.
    // Failure to remove obsolete evidence must not turn a successful save into an error.
    const keep=new Set(['draft.json',...draft.files.map(f=>f.id)]);
    for(const name of await fs.readdir(dir))if(!keep.has(name))await fs.rm(path.join(dir,name),{force:true}).catch(()=>{});
    return draft;
  }
  async file(email,draft,id){
    const file=draft.files.find(f=>f.id===id);if(!file)fail('Evidence not found.',404);
    return {...file,buffer:await fs.readFile(path.join(this.dir(email,draft.id),file.id))};
  }
  async remove(email,id){await fs.rm(this.dir(email,id),{recursive:true,force:true})}
  async complete(email,draft,request){
    await this.manifest(email,{...draft,submitted:true,requestId:request.id,refNo:request.ref_no,files:[],payload:null});
    for(const f of draft.files)await fs.rm(path.join(this.dir(email,draft.id),f.id),{force:true}).catch(()=>{});
  }
}

function normalizeDraft(body,files,maxBytes){
  let value;try{value=JSON.parse(String(body.draft||''))}catch{fail('Invalid draft data.')}
  if(!value||!['ERF','ECF'].includes(value.formType))fail('Choose ERF or ECF.');
  if(!Array.isArray(value.payments)||value.payments.length>16)fail('Maximum 16 payments per draft.');
  const payment=x=>({category:text(x?.category,120),purpose:text(x?.purpose,4000),paymentDate:text(x?.paymentDate,10),amount:text(x?.amount,30)});
  const payload={formType:value.formType,payments:value.payments.map(payment),editor:payment(value.editor),
    editingIndex:Number(value.editingIndex??-1),serviceOrderNumber:text(value.serviceOrderNumber,100)};
  if(!Number.isInteger(payload.editingIndex)||payload.editingIndex< -1||payload.editingIndex>=payload.payments.length)fail('Invalid payment being edited.');
  const fields=new Set(['editor',...payload.payments.map((_,i)=>`payment_${i}`)]);
  if(files.length>64||files.reduce((sum,f)=>sum+f.size,0)>maxBytes)fail(`Total evidence exceeds ${maxBytes/1024/1024} MB.`);
  if(files.some(f=>!fields.has(f.fieldname)||!mime.has(f.mimetype.toLowerCase())||f.originalname.length>255))fail('Evidence must be PDF, JPG, JPEG, or PNG attached to a payment.');
  return payload;
}

export function installDraftRoutes(app,deps){
  const {root,requireUser,upload,pool,workflowLockPool,getRequestDetail,createExpenseRequest,createEcfClaim,
    getRuntimeAppSettings,parseItemsAndFiles,persistOriginals,generateSubmissionDocs,sendWorkflowMail,maxBytes}=deps;
  const store=new DraftStore(root);
  const authorized=(employee,form)=>{if(!hasRole(employee,form,'REQUESTOR'))fail(`${form} Requestor access required.`,403)};
  const version=(draft,value)=>{if(!Number.isSafeInteger(Number(value))||Number(value)!==draft.version)fail('This draft changed in another tab. Reopen it from Draft before continuing.',409)};
  const route=handler=>async(req,res,next)=>{try{await handler(req,res)}catch(e){next(e)}};
  // Owner-wide locks also serialize quota checks. Request locks match the workflow
  // lock key so a retry cannot race approval/recall on an already committed request.
  const locked=handler=>route(async(req,res)=>{
    const client=await workflowLockPool.connect();
    const keys=[`draft-owner:${req.employee.email.toLowerCase()}`,...(req.params.id?[req.params.id]:[])];
    try{
      for(const key of keys)await client.query('select pg_advisory_lock(hashtextextended($1,0))',[key]);
      await handler(req,res);
    }finally{
      try{for(const key of keys.reverse())await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[key]);client.release()}
      catch{client.release(true)}
    }
  });
  const load=async req=>{const draft=await store.read(req.employee.email,req.params.id);authorized(req.employee,draft.formType);return draft};
  const editable=async draft=>{if(draft.submitted||(await getRequestDetail(draft.id)))fail('This draft has already created a request. Submit again to finish, or open it in My Requests.',409)};
  const publicDraft=draft=>({...draft,files:draft.files.map(f=>({...f,url:`/api/drafts/${draft.id}/files/${f.id}`}))});

  app.get('/api/drafts',requireUser,locked(async(req,res)=>{
    const rows=(await store.list(req.employee.email)).filter(d=>hasRole(req.employee,d.formType,'REQUESTOR'));
    res.json({drafts:rows.map(d=>({id:d.id,version:d.version,formType:d.formType,updatedAt:d.updatedAt,
      purpose:d.payload.payments[0]?.purpose||d.payload.editor.purpose||'Untitled draft',
      payments:d.payload.payments.length,total:d.payload.payments.reduce((s,p)=>s+(Number(p.amount)||0),0)}))});
  }));
  app.post('/api/drafts',requireUser,upload.any(),locked(async(req,res)=>{
    const payload=normalizeDraft(req.body,req.files||[],maxBytes);authorized(req.employee,payload.formType);
    if((await store.list(req.employee.email)).length>=100)fail('You can keep up to 100 drafts. Delete or submit an existing draft first.',409);
    res.status(201).json(publicDraft(await store.save(req.employee.email,null,payload,req.files||[])));
  }));
  app.get('/api/drafts/:id',requireUser,locked(async(req,res)=>{
    const draft=await load(req);if(draft.submitted)fail('This draft has been submitted. Open it in My Requests.',409);
    res.json({...publicDraft(draft),committed:Boolean(await getRequestDetail(draft.id))});
  }));
  app.get('/api/drafts/:id/files/:fileId',requireUser,locked(async(req,res)=>{
    const draft=await load(req),file=await store.file(req.employee.email,draft,req.params.fileId);
    res.set('Cache-Control','private, no-store').type(file.type).send(file.buffer);
  }));
  app.put('/api/drafts/:id',requireUser,upload.any(),locked(async(req,res)=>{
    const previous=await load(req);version(previous,req.body.version);await editable(previous);
    const payload=normalizeDraft(req.body,req.files||[],maxBytes);
    if(payload.formType!==previous.formType)fail('Draft form type cannot change.');
    res.json(publicDraft(await store.save(req.employee.email,previous,payload,req.files||[])));
  }));
  app.delete('/api/drafts/:id',requireUser,locked(async(req,res)=>{
    const draft=await load(req);version(draft,req.body.version);await editable(draft);
    await store.remove(req.employee.email,draft.id);res.json({ok:true});
  }));
  app.post('/api/drafts/:id/submit',requireUser,locked(async(req,res)=>{
    const draft=await load(req);version(draft,req.body.version);
    let detail=await getRequestDetail(draft.id);
    if(detail&&(!sameEmail(detail.request.requester_email,req.employee.email)||detail.request.form_type!==draft.formType))fail('Draft request mismatch.',409);
    if(!detail){
      if(!req.employee.signature_file)fail('Upload your signature before submitting.',409);
      if(draft.submitted)fail('Submitted request is unavailable.',409);
      const state=draft.payload;
      if(state.editingIndex>=0||state.editor.category.trim()||state.editor.purpose.trim()||state.editor.amount.trim()||draft.files.some(f=>f.field==='editor'))
        fail('Add or update the payment you are editing before submitting.');
      const files=await Promise.all(draft.files.map(async f=>{const file=await store.file(req.employee.email,draft,f.id);return {originalname:file.name,mimetype:file.type,size:file.size,fieldname:file.field.replace('payment_','evidence_'),buffer:file.buffer}}));
      const {items}=parseItemsAndFiles({body:{items:JSON.stringify(state.payments)},files},draft.formType==='ECF'?'REIMBURSEMENT':'EXPENSE');
      const settings=await getRuntimeAppSettings();
      const options={...submissionOptions(req.body),requestId:draft.id};
      if(draft.formType==='ECF')await createEcfClaim(req.employee,items,settings.timezone,state.serviceOrderNumber.trim(),options);
      else await createExpenseRequest(req.employee,items,settings.timezone,'EXPENSE',options);
      detail=await getRequestDetail(draft.id);
    }
    if(!draft.submitted){
      // A database commit may survive a disconnected client or document error.
      // Retry completes the same request; it never consumes another reference.
      if(Number(detail.request.revision)===1){
        if(!detail.request.form_pdf_path){
          const files=await Promise.all(draft.files.map(async f=>{const file=await store.file(req.employee.email,draft,f.id);return {originalname:file.name,mimetype:file.type,size:file.size,fieldname:file.field.replace('payment_','evidence_'),buffer:file.buffer}}));
          await persistOriginals(draft.id,1,files);
          ({detail}=await generateSubmissionDocs(draft.id,files));
        }
        const mailed=await pool.query("select 1 from email_log where request_id=$1 and event='SUBMITTED' limit 1",[draft.id]);
        if(!mailed.rowCount&&['PENDING_CHECK','PENDING_REVIEW','PENDING_APPROVAL'].includes(detail.request.status)){
          await sendWorkflowMail({event:'SUBMITTED',request:detail.request,to:pendingRecipients(detail.request),
            subject:`[${draft.formType}] ${detail.request.ref_no} submitted`,
            text:`${detail.request.employee_name} submitted ${detail.request.ref_no} for ${detail.request.status==='PENDING_CHECK'?'checking':detail.request.status==='PENDING_APPROVAL'?'final approval':'review'}.`});
        }
      }
      await store.complete(req.employee.email,draft,detail.request);
    }
    res.json({ok:true,requestId:draft.id,refNo:detail.request.ref_no,status:detail.request.status,revision:detail.request.revision});
  }));
}
