import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  pool,workflowLockPool,pingDb,getEmployee,authenticateLocalUser,changeEmployeePassword,updateEmployeeSignature,listManagedEmployees,
  createManagedEmployee,updateManagedEmployee,setManagedEmployeeActive,ensureBootstrapAdminCredentials,
  listRequestsForEmployee,listDecisionHistory,hasDecisionHistory,listTasksForEmployee,listMyRequests,getEcfRole,getEmsDashboard,
  createExpenseRequest,createEcfClaim,
  getRequestDetail,setDocumentPaths,transitionRequest,recallExpenseRequest,recallReviewedExpenseRequest,recallApprovedExpenseRequest,reviseExpenseRequest
} from './db.js';
import { buildEvidencePdf,buildFormPdf } from './documents.js';
import { buildRequestPacket } from './request-packet.js';
import {approvalArchivePath} from './approval-archive.js';
import { sendWorkflowMail,testSmtp } from './mailer.js';
import { configureAuth,googleAuthReady,passport } from './auth.js';
import {
  ensureAppSettings,getRuntimeAppSettings,getPublicAppSettings,saveAppSettings,
  rotateSessionSecret,getAppReadiness
} from './settings.js';

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const app=express();
const PORT=Number(process.env.PORT || 8080);
const PgStore=connectPgSimple(session);
const DATA_DIR=process.env.PDF_DIR || '/data/pdfs';
const PROFILE_SIGNATURE_DIR=process.env.PROFILE_SIGNATURE_DIR || path.join(DATA_DIR,'profile-signatures');
const MAX_EVIDENCE_MB=Number(process.env.MAX_EVIDENCE_MB || 15);
const allowedMime=new Set(['application/pdf','image/png','image/jpeg','image/jpg']);
const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:MAX_EVIDENCE_MB*1024*1024,files:64}
});
const signatureUpload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:5*1024*1024,files:1}
});

await ensureBootstrapAdminCredentials();
await ensureAppSettings();
const bootSettings=await getRuntimeAppSettings();
configureAuth(bootSettings);

app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false}));
app.use(session({
  store:new PgStore({pool,createTableIfMissing:true}),
  secret:bootSettings.sessionSecret || process.env.SESSION_SECRET || 'dev-only-change-me',
  resave:false,
  saveUninitialized:false,
  cookie:{
    httpOnly:true,
    sameSite:'lax',
    secure:Boolean(bootSettings.cookieSecure),
    maxAge:Number(bootSettings.sessionHours||8)*60*60*1000
  }
}));
app.use(passport.initialize());
app.use(passport.session());

const loginAttempts=new Map();
function loginAttemptKey(req){
  return String(req.ip||req.socket?.remoteAddress||'unknown');
}
function clearExpiredLoginAttempts(){
  const now=Date.now();
  for(const [key,state] of loginAttempts.entries()){
    if(state.resetAt<=now) loginAttempts.delete(key);
  }
}

app.get('/health', async (req,res)=>{
  try{
    const db=await pingDb();
    const settings=await getRuntimeAppSettings();
    res.json({
      ok:true,
      app:'Metrotech ERF',
      db:true,
      time:db.now,
      localLoginEnabled:settings.localLoginEnabled,
      googleAuthReady:googleAuthReady(settings),
      smtpEnabled:settings.smtpEnabled,
      pdfMode:'local'
    });
  }catch(e){
    res.status(503).json({ok:false,error:e.message});
  }
});

app.get('/api/auth-mode',async(req,res,next)=>{
  try{
    const settings=await getRuntimeAppSettings();
    res.json({
      devAuth:settings.localLoginEnabled,
      localLoginEnabled:settings.localLoginEnabled,
      googleAuthReady:googleAuthReady(settings)
    });
  }catch(e){next(e)}
});

app.get('/auth/google',async(req,res,next)=>{
  try{
    const settings=await getRuntimeAppSettings();
    if(!googleAuthReady(settings))
      return res.status(503).send('Google Workspace authentication is not configured.');
    configureAuth(settings);
    return passport.authenticate('google',{scope:['profile','email']})(req,res,next);
  }catch(e){next(e)}
});

app.get('/auth/google/callback',async(req,res,next)=>{
  try{
    const settings=await getRuntimeAppSettings();
    if(!googleAuthReady(settings)) return res.redirect('/?auth=unavailable');
    configureAuth(settings);
    return passport.authenticate('google',{failureRedirect:'/?auth=failed'})(req,res,()=>res.redirect('/'));
  }catch(e){next(e)}
});

app.post('/api/login',async(req,res,next)=>{
  try{
    const settings=await getRuntimeAppSettings();
    if(!settings.localLoginEnabled)
      return res.status(404).json({error:'Local login is disabled.'});

    clearExpiredLoginAttempts();
    const key=loginAttemptKey(req);
    const current=loginAttempts.get(key);
    const limit=Number(settings.loginRateLimit||10);
    if(current && current.count>=limit)
      return res.status(429).json({error:'Too many failed login attempts. Try again later.'});

    const username=String(req.body.username||'').trim();
    const password=String(req.body.password||'');
    const employee=await authenticateLocalUser(username,password);

    if(!employee){
      const state=current && current.resetAt>Date.now()
        ? current
        : {count:0,resetAt:Date.now()+15*60*1000};
      state.count+=1;
      loginAttempts.set(key,state);
      return res.status(401).json({error:'Invalid username or password.'});
    }

    loginAttempts.delete(key);
    req.session.user={email:employee.email};
    res.json({ok:true,employee,setupRequired:employeeNeedsSetup(employee)});
  }catch(e){next(e)}
});

app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));

const setupAllowedPaths=new Set([
  '/api/me',
  '/api/profile',
  '/api/profile/password',
  '/api/profile/signature'
]);

function employeeNeedsSetup(employee){
  return Boolean(
    employee &&
    employee.role!=='ADMIN' &&
    (employee.must_change_password || employee.must_upload_signature)
  );
}

async function requireUser(req,res,next){
  try{
    const email=req.session?.user?.email || req.user?.email;
    if(!email) return res.status(401).json({error:'Authentication required'});
    const employee=await getEmployee(email);
    if(!employee) return res.status(403).json({error:'Employee is inactive or missing'});
    req.employee=employee;
    employee.ecfRole=await getEcfRole(employee.email);
    if(employeeNeedsSetup(employee) && !setupAllowedPaths.has(req.path))
      return res.status(428).json({
        error:'Complete your first login setup before using the system.',
        code:'SETUP_REQUIRED'
      });
    next();
  }catch(e){next(e)}
}

function requireAdmin(req,res,next){
  if(req.employee?.role!=='ADMIN') return res.status(403).json({error:'Admin access required.'});
  next();
}

function canAccess(employee,request){
  if(request.form_type==='ECF' && employee.ecfRole==='CHECKER' &&
     request.status==='PENDING_CHECK') return true;
  if(request.form_type==='ECF' && employee.ecfRole==='NONE') return false;
  if(request.form_type==='ECF' && employee.role==='NONE' && employee.ecfRole!=='NONE')
    return String(request.requester_email).toLowerCase()===String(employee.email).toLowerCase();
  if(employee.role==='REQUESTOR') return String(request.requester_email).toLowerCase()===String(employee.email).toLowerCase();
  if(employee.role==='REVIEWER') return String(request.reviewer_email).toLowerCase()===String(employee.email).toLowerCase();
  if(employee.role==='APPROVER') return String(request.approver_email).toLowerCase()===String(employee.email).toLowerCase();
  return false;
}

async function canViewRequest(employee,request){
  return canAccess(employee,request) || (request.form_type==='ERF' && await hasDecisionHistory(request.id,employee));
}

function normalizeRequestType(value){
  const type=String(value||'EXPENSE').trim().toUpperCase();
  if(!['EXPENSE','REIMBURSEMENT'].includes(type))
    throw Object.assign(new Error('Request type must be EXPENSE or REIMBURSEMENT.'),{status:400});
  return type;
}

function requestCode(request){
  if(request?.form_type==='ECF') return 'ECF';
  return String(request?.request_type||'').toUpperCase()==='REIMBURSEMENT' || String(request?.ref_no||'').startsWith('RRF-')
    ? 'RRF'
    : 'ERF';
}

function parseItemsAndFiles(req,requestType='EXPENSE'){
  const evidenceRequired=normalizeRequestType(requestType)==='REIMBURSEMENT';
  let rawItems;
  try { rawItems=JSON.parse(String(req.body.items||'[]')); }
  catch { throw Object.assign(new Error('Invalid payment data.'),{status:400}); }
  if(!Array.isArray(rawItems)||!rawItems.length) throw Object.assign(new Error('Add at least one payment.'),{status:400});
  if(rawItems.length>16) throw Object.assign(new Error('Maximum 16 payments per request.'),{status:400});

  const files=req.files||[];
  if(files.some(f=>!allowedMime.has(String(f.mimetype).toLowerCase())))
    throw Object.assign(new Error('Evidence must be PDF, JPG, JPEG, or PNG.'),{status:400});
  const totalBytes=files.reduce((s,f)=>s+f.size,0);
  if(totalBytes>MAX_EVIDENCE_MB*1024*1024)
    throw Object.assign(new Error(`Total evidence exceeds ${MAX_EVIDENCE_MB} MB.`),{status:400});

  const items=rawItems.map((x,i)=>{
    const category=String(x.category||'').trim();
    const purpose=String(x.purpose||'').trim();
    const paymentDate=String(x.paymentDate||'').trim();
    const amount=Math.round(Number(x.amount));
    const itemFiles=files.filter(f=>f.fieldname===`evidence_${i}`);
    if(!category||!purpose||!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)||!Number.isFinite(amount)||amount<=0)
      throw Object.assign(new Error(`Payment #${i+1} is incomplete.`),{status:400});
    if(evidenceRequired&&!itemFiles.length)
      throw Object.assign(new Error(`Payment #${i+1} requires evidence for reimbursement.`),{status:400});
    return {category,purpose,paymentDate,amount,evidenceNames:itemFiles.map(f=>f.originalname)};
  });
  return {items,files};
}

async function persistOriginals(requestId,revision,files){
  const dir=path.join(DATA_DIR,String(requestId),`r${revision}`,'evidence-original');
  await fs.mkdir(dir,{recursive:true});
  for(let n=0;n<files.length;n++){
    const f=files[n];
    const safe=String(f.originalname||'evidence').replace(/[^a-zA-Z0-9._-]+/g,'_');
    const idx=String(f.fieldname).replace('evidence_','');
    await fs.writeFile(path.join(dir,`${String(Number(idx)+1).padStart(2,'0')}-${String(n+1).padStart(2,'0')}-${safe}`),f.buffer);
  }
}

function evidenceMimeFromName(filename){
  const ext=path.extname(String(filename||'')).toLowerCase();
  if(ext==='.pdf') return 'application/pdf';
  if(ext==='.png') return 'image/png';
  if(ext==='.jpg'||ext==='.jpeg') return 'image/jpeg';
  return '';
}

async function loadExistingEvidenceFiles(requestId,revision,lineNo,targetIndex,evidenceNames=[]){
  const dir=path.join(DATA_DIR,String(requestId),`r${revision}`,'evidence-original');
  let names=[];
  try{
    names=(await fs.readdir(dir))
      .filter(name=>name.startsWith(`${String(Number(lineNo)).padStart(2,'0')}-`))
      .sort();
  }catch{
    return [];
  }

  const files=[];
  for(let i=0;i<names.length;i++){
    const storedName=names[i];
    const buffer=await fs.readFile(path.join(dir,storedName));
    const fallbackName=storedName.replace(/^\d+-\d+-/,'')||'evidence';
    const originalname=String(evidenceNames[i]||fallbackName);
    const mimetype=evidenceMimeFromName(originalname)||evidenceMimeFromName(storedName);
    if(!allowedMime.has(mimetype)) continue;
    files.push({
      fieldname:`evidence_${targetIndex}`,
      originalname,
      mimetype,
      size:buffer.length,
      buffer
    });
  }
  return files;
}

async function parseRevisionItemsAndFiles(req,detail){
  const requestType=normalizeRequestType(detail.request?.request_type||'EXPENSE');
  const evidenceRequired=detail.request?.form_type==='ECF'||requestType==='REIMBURSEMENT';
  let rawItems;
  try { rawItems=JSON.parse(String(req.body.items||'[]')); }
  catch { throw Object.assign(new Error('Invalid payment data.'),{status:400}); }

  if(!Array.isArray(rawItems)||!rawItems.length)
    throw Object.assign(new Error('Add at least one payment.'),{status:400});
  if(rawItems.length>16)
    throw Object.assign(new Error('Maximum 16 payments per request.'),{status:400});

  const uploaded=req.files||[];
  if(uploaded.some(f=>!allowedMime.has(String(f.mimetype).toLowerCase())))
    throw Object.assign(new Error('Evidence must be PDF, JPG, JPEG, or PNG.'),{status:400});

  const uploadedBytes=uploaded.reduce((s,f)=>s+f.size,0);
  if(uploadedBytes>MAX_EVIDENCE_MB*1024*1024)
    throw Object.assign(new Error(`Total uploaded evidence exceeds ${MAX_EVIDENCE_MB} MB.`),{status:400});

  const currentItems=new Map((detail.items||[]).map(item=>[Number(item.line_no),item]));
  const items=[];
  const files=[];

  for(let i=0;i<rawItems.length;i++){
    const x=rawItems[i]||{};
    const category=String(x.category||'').trim();
    const purpose=String(x.purpose||'').trim();
    const paymentDate=String(x.paymentDate||'').trim();
    const amount=Math.round(Number(x.amount));

    if(!category||!purpose||!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)||!Number.isFinite(amount)||amount<=0)
      throw Object.assign(new Error(`Payment #${i+1} is incomplete.`),{status:400});

    let itemFiles=uploaded.filter(f=>f.fieldname===`evidence_${i}`);
    let evidenceNames=itemFiles.map(f=>f.originalname);

    if(!itemFiles.length){
      const sourceLineNo=Number(x.sourceLineNo);
      const sourceItem=Number.isInteger(sourceLineNo)&&sourceLineNo>0
        ? currentItems.get(sourceLineNo)
        : null;

      if(sourceItem){
        itemFiles=await loadExistingEvidenceFiles(
          detail.request.id,
          detail.request.revision,
          sourceLineNo,
          i,
          sourceItem.evidence_names||[]
        );

        if(itemFiles.length){
          evidenceNames=(sourceItem.evidence_names||[]).length
            ? sourceItem.evidence_names
            : itemFiles.map(f=>f.originalname);
        }else if(evidenceRequired||(sourceItem.evidence_names||[]).length){
          throw Object.assign(new Error(
            `Existing evidence for Payment #${i+1} is unavailable. Please attach evidence again.`
          ),{status:400});
        }
      }else if(evidenceRequired){
        throw Object.assign(new Error(`Payment #${i+1} requires evidence for reimbursement.`),{status:400});
      }
    }

    files.push(...itemFiles);
    items.push({category,purpose,paymentDate,amount,evidenceNames});
  }

  const totalBytes=files.reduce((s,f)=>s+Number(f.size||f.buffer?.length||0),0);
  if(totalBytes>MAX_EVIDENCE_MB*1024*1024)
    throw Object.assign(new Error(`Total evidence exceeds ${MAX_EVIDENCE_MB} MB.`),{status:400});

  return {items,files};
}

async function buildPacketForDetail(detail,{evidencePath=detail.request.evidence_pdf_path||null}={}){
  const dir=path.join(DATA_DIR,String(detail.request.id),`r${detail.request.revision}`);
  await fs.mkdir(dir,{recursive:true});
  const formSourcePath=path.join(dir,'.form-source.tmp.pdf');
  const packetPath=path.join(dir,'request-packet.pdf');

  try{
    await buildFormPdf({request:detail.request,items:detail.items,outPath:formSourcePath});
    await buildRequestPacket({formPath:formSourcePath,evidencePath,outPath:packetPath});
  }finally{
    await fs.rm(formSourcePath,{force:true}).catch(()=>{});
  }

  return packetPath;
}

async function generateSubmissionDocs(requestId,files){
  const detail=await getRequestDetail(requestId);
  if(!detail) throw new Error('Request disappeared after creation.');
  const dir=path.join(DATA_DIR,String(requestId),`r${detail.request.revision}`);
  let evidencePath=null;

  if(files.length){
    evidencePath=path.join(dir,'evidence.pdf');
    await buildEvidencePdf({request:detail.request,items:detail.items,files,outPath:evidencePath});
  }

  const packetPath=await buildPacketForDetail(detail,{evidencePath});
  await setDocumentPaths(requestId,packetPath,evidencePath);
  return {detail:await getRequestDetail(requestId),formPath:packetPath,evidencePath};
}

async function regenerateForm(requestId){
  const detail=await getRequestDetail(requestId);
  if(!detail) throw new Error('Request not found.');
  const packetPath=await buildPacketForDetail(detail);
  await setDocumentPaths(requestId,packetPath,null);
  return await getRequestDetail(requestId);
}

// Serialize status changes and their document writes across app instances.
function withRequestWorkflowLock(handler){
  return async(req,res,next)=>{
    let client;
    let locked=false;
    try{
      client=await workflowLockPool.connect();
      await client.query('select pg_advisory_lock(hashtextextended($1,0))',[String(req.params.id)]);
      locked=true;
      await handler(req,res,next);
    }catch(e){next(e)}finally{
      if(client){
        try{
          if(locked) await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[String(req.params.id)]);
          client.release();
        }catch(e){client.release(true);console.error(e)}
      }
    }
  };
}

app.get('/api/me',requireUser,async(req,res)=>{
  const history=await listDecisionHistory(req.employee);
  const requests=await listRequestsForEmployee(req.employee);
  const tasks=await listTasksForEmployee(req.employee);
  const myRequests=await listMyRequests(req.employee);
  res.json({employee:req.employee,requests,tasks,myRequests,history,setupRequired:employeeNeedsSetup(req.employee)});
});

app.get('/api/ems/dashboard',requireUser,async(req,res,next)=>{
  try{res.json(await getEmsDashboard(req.employee))}catch(e){next(e)}
});

app.put('/api/profile/password',requireUser,async(req,res,next)=>{
  try{
    if(req.employee.role==='ADMIN')
      return res.status(400).json({error:'Admin password is managed separately.'});

    const currentPassword=String(req.body?.currentPassword||'');
    const newPassword=String(req.body?.newPassword||'');
    const confirmPassword=String(req.body?.confirmPassword||'');

    if(!currentPassword || !newPassword || !confirmPassword)
      return res.status(400).json({error:'Complete all password fields.'});
    if(newPassword!==confirmPassword)
      return res.status(400).json({error:'New password confirmation does not match.'});
    if(newPassword===currentPassword)
      return res.status(400).json({error:'New password must be different from the current password.'});
    if(newPassword.length<12 || newPassword.length>128)
      return res.status(400).json({error:'New password must be 12–128 characters.'});
    if(!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword))
      return res.status(400).json({error:'New password must include uppercase, lowercase, and a number.'});

    const employee=await changeEmployeePassword(req.employee.email,currentPassword,newPassword);
    res.json({ok:true,employee,setupRequired:employeeNeedsSetup(employee)});
  }catch(e){next(e)}
});

app.put('/api/profile',requireUser,signatureUpload.single('signature'),async(req,res,next)=>{
  try{
    if(req.employee.role==='ADMIN')
      return res.status(400).json({error:'Admin profile is managed separately.'});
    if(!req.file) return res.status(400).json({error:'Choose a signature image first.'});

    const mime=String(req.file.mimetype||'').toLowerCase();
    if(!['image/png','image/jpeg','image/jpg'].includes(mime))
      return res.status(400).json({error:'Signature must be PNG or JPG.'});

    await fs.mkdir(PROFILE_SIGNATURE_DIR,{recursive:true});
    const ext=mime==='image/png'?'png':'jpg';
    const safeEmail=String(req.employee.email).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const signatureFile=path.join(PROFILE_SIGNATURE_DIR,`${safeEmail}-signature.${ext}`);
    await fs.writeFile(signatureFile,req.file.buffer);

    const employee=await updateEmployeeSignature(req.employee.email,signatureFile);
    res.json({ok:true,employee,setupRequired:employeeNeedsSetup(employee)});
  }catch(e){next(e)}
});

app.get('/api/profile/signature',requireUser,async(req,res,next)=>{
  try{
    if(req.employee.role==='ADMIN') return res.status(404).end();
    const signatureFile=String(req.employee.signature_file||'').trim();
    if(!signatureFile) return res.status(404).end();

    const root=path.resolve(PROFILE_SIGNATURE_DIR);
    const resolved=path.resolve(signatureFile);
    if(resolved!==root && !resolved.startsWith(`${root}${path.sep}`))
      return res.status(404).end();

    await fs.access(resolved);
    res.set('Cache-Control','private, no-store, max-age=0');
    res.sendFile(resolved);
  }catch(e){
    if(e?.code==='ENOENT') return res.status(404).end();
    next(e);
  }
});

app.get('/api/admin/users',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    res.json({users:await listManagedEmployees()});
  }catch(e){next(e)}
});

app.post('/api/admin/users',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    const user=await createManagedEmployee(req.body||{});
    res.status(201).json({ok:true,user});
  }catch(e){next(e)}
});

app.put('/api/admin/users/:email',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    const user=await updateManagedEmployee(req.params.email,req.body||{});
    res.json({ok:true,user});
  }catch(e){next(e)}
});

app.patch('/api/admin/users/:email/status',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    const active=req.body?.active===true;
    const user=await setManagedEmployeeActive(req.params.email,active);
    res.json({ok:true,user});
  }catch(e){next(e)}
});

async function buildAppManagementPayload(){
  const settings=await getPublicAppSettings();
  const readiness=await getAppReadiness();
  let storage=true;
  try{
    await fs.mkdir(DATA_DIR,{recursive:true});
    await fs.access(DATA_DIR);
  }catch{
    storage=false;
  }
  const runtime=await getRuntimeAppSettings();
  const restartRequired=
    runtime.sessionHours!==bootSettings.sessionHours ||
    runtime.cookieSecure!==bootSettings.cookieSecure ||
    runtime.sessionSecret!==bootSettings.sessionSecret;
  return {
    settings,
    readiness:{...readiness,storage},
    restartRequired
  };
}

app.get('/api/admin/app-settings',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    res.json(await buildAppManagementPayload());
  }catch(e){next(e)}
});

app.put('/api/admin/app-settings',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    await saveAppSettings(req.body||{},req.employee.email);
    const runtime=await getRuntimeAppSettings();
    configureAuth(runtime);
    res.json({ok:true,...await buildAppManagementPayload()});
  }catch(e){next(e)}
});

app.post('/api/admin/app-settings/rotate-session',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    await rotateSessionSecret(req.employee.email);
    res.json({ok:true,...await buildAppManagementPayload()});
  }catch(e){next(e)}
});

app.post('/api/admin/app-settings/test-smtp',requireUser,requireAdmin,async(req,res,next)=>{
  try{
    const to=String(req.body?.to||'').trim();
    await testSmtp(to);
    res.json({ok:true,message:`Test email sent to ${to}.`});
  }catch(e){next(e)}
});

app.post('/api/requests',requireUser,upload.any(),async(req,res,next)=>{
  try{
    if(req.employee.role!=='REQUESTOR') return res.status(403).json({error:'Only Requestor can create a request.'});
    const requestType=normalizeRequestType(req.body.requestType||'EXPENSE');
    if(requestType!=='EXPENSE') return res.status(400).json({error:'Use Expense Claim (ECF) for claims.'});
    const {items,files}=parseItemsAndFiles(req,requestType);
    const runtimeSettings=await getRuntimeAppSettings();
    const request=await createExpenseRequest(req.employee,items,runtimeSettings.timezone,requestType);

    await persistOriginals(request.id,1,files);
    const {detail}=await generateSubmissionDocs(request.id,files);
    await sendWorkflowMail({
      event:'SUBMITTED',request:detail.request,to:detail.request.reviewer_email,
      subject:`[${requestCode(detail.request)}] ${detail.request.ref_no} pending review`,
      text:`${detail.request.employee_name} submitted ${detail.request.ref_no} for review.`
    });
    res.status(201).json({
      ok:true,requestId:request.id,refNo:request.ref_no,status:'PENDING_REVIEW',revision:1,
      requestType:detail.request.request_type
    });
  }catch(e){next(e)}
});

app.post('/api/ecf/claims',requireUser,upload.any(),async(req,res,next)=>{
  try{
    if(req.employee.ecfRole!=='REQUESTOR') return res.status(403).json({error:'ECF Requestor access required.'});
    const {items,files}=parseItemsAndFiles(req,'REIMBURSEMENT');
    const settings=await getRuntimeAppSettings();
    const request=await createEcfClaim(req.employee,items,settings.timezone,
      String(req.body.serviceOrderNumber||'').trim().slice(0,100));
    await persistOriginals(request.id,1,files);
    const {detail}=await generateSubmissionDocs(request.id,files);
    await sendWorkflowMail({event:'SUBMITTED',request:detail.request,to:detail.request.checker_email,
      subject:`[ECF] ${request.ref_no} pending check`,
      text:`${request.employee_name} submitted ${request.ref_no} for checking.`});
    res.status(201).json({ok:true,requestId:request.id,refNo:request.ref_no,status:request.status});
  }catch(e){next(e)}
});

app.post('/api/requests/:id/recall',requireUser,withRequestWorkflowLock(async(req,res,next)=>{
  try{
    const approvedRecall=req.employee.role==='APPROVER';
    const reviewedRecall=req.employee.role==='REVIEWER';
    const decisionRecall=approvedRecall||reviewedRecall;
    if(!decisionRecall){
    const current=await getRequestDetail(req.params.id);
    if(!current) return res.status(404).json({error:'Request not found'});
    if(current.request.form_type==='ECF'
      ? !['REQUESTOR','NONE'].includes(req.employee.role) || req.employee.ecfRole!=='REQUESTOR'
      : req.employee.role!=='REQUESTOR')
      return res.status(403).json({error:'Requestor access required to recall this request.'});
    }
    const request=approvedRecall
      ? await recallApprovedExpenseRequest(req.params.id,req.employee,req.body?.reason)
      : reviewedRecall
        ? await recallReviewedExpenseRequest(req.params.id,req.employee,req.body?.reason)
        : await recallExpenseRequest(req.params.id,req.employee);
    const detail=approvedRecall?await getRequestDetail(request.id):await regenerateForm(request.id);
    await sendWorkflowMail({
      event:approvedRecall?'APPROVAL_RECALLED':reviewedRecall?'REVIEW_RECALLED':'RECALLED',
      request:detail.request,
      to:decisionRecall?detail.request.requester_email:detail.request.form_type==='ECF'?detail.request.checker_email:detail.request.reviewer_email,
      cc:approvedRecall?[detail.request.reviewer_email,(await getRuntimeAppSettings()).finalApprovedCc]:reviewedRecall?detail.request.approver_email:undefined,
      subject:`[${requestCode(detail.request)}] ${detail.request.ref_no} ${approvedRecall?'approval recalled':reviewedRecall?'review recalled':'recalled by requestor'}`,
      text:decisionRecall
        ? `${detail.request.ref_no} ${approvedRecall?'approval':'review'} was recalled by ${req.employee.name}. Reason: ${request.last_rejection_reason}. The previous approval is no longer current. Requestor must revise and resubmit for a new review and approval.`
        : `${detail.request.ref_no} was recalled by ${req.employee.name} and no longer requires review.`
    });
    res.json({ok:true,status:detail.request.status,refNo:detail.request.ref_no});
  }catch(e){next(e)}
}));

app.post('/api/requests/:id/revise',requireUser,upload.any(),withRequestWorkflowLock(async(req,res,next)=>{
  try{
    const currentDetail=await getRequestDetail(req.params.id);
    if(!currentDetail) return res.status(404).json({error:'Request not found'});
    if(currentDetail.request.form_type==='ECF'
      ? !['REQUESTOR','NONE'].includes(req.employee.role) || req.employee.ecfRole!=='REQUESTOR'
      : req.employee.role!=='REQUESTOR')
      return res.status(403).json({error:'Requestor access required to revise this request.'});
    if(!canAccess(req.employee,currentDetail.request)) return res.status(403).json({error:'Access denied'});

    const {items,files}=await parseRevisionItemsAndFiles(req,currentDetail);
    const request=await reviseExpenseRequest(req.params.id,req.employee,items,{
      serviceOrderNumber:req.body.serviceOrderNumber
    });
    await persistOriginals(request.id,request.revision,files);
    const {detail}=await generateSubmissionDocs(request.id,files);
    await sendWorkflowMail({
      event:'REVISED',request:detail.request,to:detail.request.form_type==='ECF'?detail.request.checker_email:detail.request.reviewer_email,
      subject:`[${requestCode(detail.request)}] ${detail.request.ref_no} revised and pending review`,
      text:`${detail.request.employee_name} submitted revision ${detail.request.revision} of ${detail.request.ref_no}.`
    });
    res.json({
      ok:true,requestId:request.id,refNo:request.ref_no,status:request.status,revision:request.revision,
      requestType:detail.request.request_type
    });
  }catch(e){next(e)}
}));

app.get('/api/requests/:id',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail) return res.status(404).json({error:'Request not found'});
    if(!await canViewRequest(req.employee,detail.request)) return res.status(403).json({error:'Access denied'});
    const {form_pdf_path,evidence_pdf_path,...safeRequest}=detail.request;
    const originalsDir=path.join(DATA_DIR,String(detail.request.id),`r${detail.request.revision}`,'evidence-original');
    let originals=[];
    try{originals=await fs.readdir(originalsDir)}catch(e){if(e.code!=='ENOENT') throw e}
    const items=detail.items.map(item=>({...item,evidenceReusable:
      originals.filter(name=>name.startsWith(`${String(item.line_no).padStart(2,'0')}-`)).length===(item.evidence_names||[]).length
    }));
    res.json({
      request:safeRequest,
      items,
      actions:detail.actions,
      documents:{packet:!!form_pdf_path,form:!!form_pdf_path,evidence:!!evidence_pdf_path}
    });
  }catch(e){next(e)}
});

app.get('/api/requests/:id/approval-archive/:revision',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail||!await canViewRequest(req.employee,detail.request)) return res.status(404).end();
    const revision=Number(req.params.revision);
    if(!Number.isInteger(revision)||!detail.actions.some(a=>a.action==='APPROVAL_RECALLED'&&Number(a.revision)===revision))
      return res.status(404).end();
    res.download(path.resolve(approvalArchivePath({...detail.request,revision})),`${detail.request.ref_no}-r${revision}-SUPERSEDED.pdf`);
  }catch(e){next(e)}
});

app.get('/api/requests/:id/form',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail||!await canViewRequest(req.employee,detail.request)) return res.status(404).end();
    if(!detail.request.form_pdf_path) return res.status(404).json({error:'Request packet PDF is not available.'});
    res.sendFile(path.resolve(detail.request.form_pdf_path));
  }catch(e){next(e)}
});

app.get('/api/requests/:id/form/download',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail||!await canViewRequest(req.employee,detail.request)) return res.status(404).end();
    if(detail.request.status!=='APPROVED')
      return res.status(409).json({error:'Final PDF is available after full approval.'});
    if(!detail.request.form_pdf_path)
      return res.status(404).json({error:'Final request packet PDF is not available.'});
    res.download(path.resolve(detail.request.form_pdf_path),`${detail.request.ref_no}.pdf`);
  }catch(e){next(e)}
});

app.get('/api/requests/:id/evidence',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail||!await canViewRequest(req.employee,detail.request)) return res.status(404).end();
    if(!detail.request.evidence_pdf_path) return res.status(404).json({error:'Evidence PDF is not available.'});
    res.sendFile(path.resolve(detail.request.evidence_pdf_path));
  }catch(e){next(e)}
});

app.post('/api/requests/:id/review',requireUser,withRequestWorkflowLock(async(req,res,next)=>{
  try{
    const request=await transitionRequest(req.params.id,req.employee,'REVIEW',req.body.decision,req.body.reason||'');
    const detail=await regenerateForm(request.id);
    const approved=detail.request.status==='PENDING_APPROVAL';
    const code=requestCode(detail.request);
    await sendWorkflowMail({
      event:approved?'REVIEW_APPROVED':'REVIEW_REJECTED',request:detail.request,
      to:approved?detail.request.approver_email:detail.request.requester_email,
      subject:approved?`[${code}] ${detail.request.ref_no} pending final approval`:`[${code}] ${detail.request.ref_no} rejected by reviewer`,
      text:approved?`${detail.request.ref_no} was reviewed by ${req.employee.name} and is ready for final approval.`
        :`${detail.request.ref_no} was rejected by ${req.employee.name}. Reason: ${req.body.reason}`
    });
    res.json({ok:true,status:detail.request.status});
  }catch(e){next(e)}
}));

app.post('/api/requests/:id/check',requireUser,async(req,res,next)=>{
  try{
    const request=await transitionRequest(req.params.id,req.employee,'CHECK',req.body.decision,req.body.reason||'');
    const detail=await regenerateForm(request.id);
    const passed=request.status==='PENDING_REVIEW';
    await sendWorkflowMail({event:passed?'CHECK_APPROVED':'CHECK_REJECTED',request:detail.request,
      to:passed?request.reviewer_email:request.requester_email,
      subject:`[ECF] ${request.ref_no} ${passed?'pending review':'rejected by Checker'}`,
      text:passed?`${request.ref_no} has passed the Checker stage.`:
        `${request.ref_no} was rejected by Checker. Reason: ${req.body.reason}`});
    res.json({ok:true,status:request.status});
  }catch(e){next(e)}
});

app.post('/api/requests/:id/approve',requireUser,withRequestWorkflowLock(async(req,res,next)=>{
  try{
    const request=await transitionRequest(req.params.id,req.employee,'APPROVAL',req.body.decision,req.body.reason||'');
    const detail=await regenerateForm(request.id);
    const approved=detail.request.status==='APPROVED';
    const code=requestCode(detail.request);
    const attachments=approved?[
      {filename:`${detail.request.ref_no}.pdf`,path:detail.request.form_pdf_path}
    ]:[];
    await sendWorkflowMail({
      event:approved?'FINAL_APPROVED':'APPROVAL_REJECTED',request:detail.request,
      to:detail.request.requester_email,
      cc:approved?[detail.request.reviewer_email,(await getRuntimeAppSettings()).finalApprovedCc]:detail.request.reviewer_email,
      subject:approved?`[${code}] ${detail.request.ref_no} approved`:`[${code}] ${detail.request.ref_no} rejected by approver`,
      text:approved?`${detail.request.ref_no} has been approved by ${req.employee.name}.`
        :`${detail.request.ref_no} was rejected by ${req.employee.name}. Reason: ${req.body.reason}`,
      attachments
    });

    // Keep revision documents and original evidence for future recalls and audit.

    res.json({ok:true,status:detail.request.status});
  }catch(e){next(e)}
}));

app.get('/app.js',async(req,res,next)=>{
  try{
    const [base,extension]=await Promise.all([
      fs.readFile(path.join(__dirname,'../public/app.js'),'utf8'),
      fs.readFile(path.join(__dirname,'../public/request-type.js'),'utf8')
    ]);
    res.type('application/javascript').send(`${base}\n\n${extension}`);
  }catch(e){next(e)}
});

app.use('/vendor/pdfjs',express.static(path.join(__dirname,'../node_modules/pdfjs-dist/build')));
app.use(express.static(path.join(__dirname,'../public')));
app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

app.use((err,req,res,next)=>{
  console.error(err);
  if(err instanceof multer.MulterError) return res.status(400).json({error:err.message});
  res.status(err.status||500).json({error:err.message||'Internal server error'});
});

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`Metrotech ERF listening on :${PORT} | Local Login=${bootSettings.localLoginEnabled}`);
});
