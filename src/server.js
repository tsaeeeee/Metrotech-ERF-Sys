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
  pool,pingDb,getEmployee,authenticateLocalUser,updateEmployeeSignature,listManagedEmployees,
  createManagedEmployee,updateManagedEmployee,setManagedEmployeeActive,ensureBootstrapAdminCredentials,
  listRequestsForEmployee,createExpenseRequest,
  getRequestDetail,setDocumentPaths,transitionRequest,recallExpenseRequest,reviseExpenseRequest
} from './db.js';
import { buildEvidencePdf,buildFormPdf } from './documents.js';
import { buildRequestPacket } from './request-packet.js';
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
    res.json({ok:true,employee});
  }catch(e){next(e)}
});

app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));

async function requireUser(req,res,next){
  try{
    const email=req.session?.user?.email || req.user?.email;
    if(!email) return res.status(401).json({error:'Authentication required'});
    const employee=await getEmployee(email);
    if(!employee) return res.status(403).json({error:'Employee is inactive or missing'});
    req.employee=employee;
    next();
  }catch(e){next(e)}
}

function requireAdmin(req,res,next){
  if(req.employee?.role!=='ADMIN') return res.status(403).json({error:'Admin access required.'});
  next();
}

function canAccess(employee,request){
  if(employee.role==='REQUESTOR') return String(request.requester_email).toLowerCase()===String(employee.email).toLowerCase();
  if(employee.role==='REVIEWER') return String(request.reviewer_email).toLowerCase()===String(employee.email).toLowerCase();
  if(employee.role==='APPROVER') return String(request.approver_email).toLowerCase()===String(employee.email).toLowerCase();
  return false;
}

function normalizeRequestType(value){
  const type=String(value||'EXPENSE').trim().toUpperCase();
  if(!['EXPENSE','REIMBURSEMENT'].includes(type))
    throw Object.assign(new Error('Request type must be EXPENSE or REIMBURSEMENT.'),{status:400});
  return type;
}

function requestCode(request){
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
  const evidenceRequired=requestType==='REIMBURSEMENT';
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
        }else if(evidenceRequired){
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

async function cleanupApprovedRequestFiles(detail){
  const request=detail.request;
  const root=path.join(DATA_DIR,String(request.id));
  const keepRevision=`r${request.revision}`;
  const packetPath=request.form_pdf_path;
  const packetName=path.basename(String(packetPath||'request-packet.pdf'));

  let rootEntries=[];
  try{rootEntries=await fs.readdir(root,{withFileTypes:true})}catch{return}

  for(const entry of rootEntries){
    if(entry.name===keepRevision) continue;
    await fs.rm(path.join(root,entry.name),{recursive:true,force:true});
  }

  const currentDir=path.join(root,keepRevision);
  let currentEntries=[];
  try{currentEntries=await fs.readdir(currentDir,{withFileTypes:true})}catch{}
  for(const entry of currentEntries){
    if(entry.name===packetName) continue;
    await fs.rm(path.join(currentDir,entry.name),{recursive:true,force:true});
  }

  await setDocumentPaths(request.id,packetPath,'');
}

app.get('/api/me',requireUser,async(req,res)=>{
  const requests=await listRequestsForEmployee(req.employee);
  res.json({employee:req.employee,requests});
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
    res.json({ok:true,employee});
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
    const requestType='EXPENSE'; // Production ERF: new submissions are ERF-only.
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

app.post('/api/requests/:id/recall',requireUser,async(req,res,next)=>{
  try{
    if(req.employee.role!=='REQUESTOR') return res.status(403).json({error:'Only Requestor can recall a request.'});
    const request=await recallExpenseRequest(req.params.id,req.employee);
    const detail=await regenerateForm(request.id);
    await sendWorkflowMail({
      event:'RECALLED',
      request:detail.request,
      to:detail.request.reviewer_email,
      subject:`[${requestCode(detail.request)}] ${detail.request.ref_no} recalled by requestor`,
      text:`${detail.request.ref_no} was recalled by ${req.employee.name} and no longer requires review.`
    });
    res.json({ok:true,status:detail.request.status,refNo:detail.request.ref_no});
  }catch(e){next(e)}
});

app.post('/api/requests/:id/revise',requireUser,upload.any(),async(req,res,next)=>{
  try{
    if(req.employee.role!=='REQUESTOR') return res.status(403).json({error:'Only Requestor can revise a request.'});

    const currentDetail=await getRequestDetail(req.params.id);
    if(!currentDetail) return res.status(404).json({error:'Request not found'});
    if(!canAccess(req.employee,currentDetail.request)) return res.status(403).json({error:'Access denied'});

    const {items,files}=await parseRevisionItemsAndFiles(req,currentDetail);
    const request=await reviseExpenseRequest(req.params.id,req.employee,items);
    await persistOriginals(request.id,request.revision,files);
    const {detail}=await generateSubmissionDocs(request.id,files);
    await sendWorkflowMail({
      event:'REVISED',request:detail.request,to:detail.request.reviewer_email,
      subject:`[${requestCode(detail.request)}] ${detail.request.ref_no} revised and pending review`,
      text:`${detail.request.employee_name} submitted revision ${detail.request.revision} of ${detail.request.ref_no}.`
    });
    res.json({
      ok:true,requestId:request.id,refNo:request.ref_no,status:'PENDING_REVIEW',revision:request.revision,
      requestType:detail.request.request_type
    });
  }catch(e){next(e)}
});

app.get('/api/requests/:id',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail) return res.status(404).json({error:'Request not found'});
    if(!canAccess(req.employee,detail.request)) return res.status(403).json({error:'Access denied'});
    const {form_pdf_path,evidence_pdf_path,...safeRequest}=detail.request;
    res.json({
      request:safeRequest,
      items:detail.items,
      actions:detail.actions,
      documents:{packet:!!form_pdf_path,form:!!form_pdf_path,evidence:!!evidence_pdf_path}
    });
  }catch(e){next(e)}
});

app.get('/api/requests/:id/form',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail||!canAccess(req.employee,detail.request)) return res.status(404).end();
    if(!detail.request.form_pdf_path) return res.status(404).json({error:'Request packet PDF is not available.'});
    res.sendFile(path.resolve(detail.request.form_pdf_path));
  }catch(e){next(e)}
});

app.get('/api/requests/:id/form/download',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail||!canAccess(req.employee,detail.request)) return res.status(404).end();
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
    if(!detail||!canAccess(req.employee,detail.request)) return res.status(404).end();
    if(!detail.request.evidence_pdf_path) return res.status(404).json({error:'Evidence PDF is not available.'});
    res.sendFile(path.resolve(detail.request.evidence_pdf_path));
  }catch(e){next(e)}
});

app.post('/api/requests/:id/review',requireUser,async(req,res,next)=>{
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
});

app.post('/api/requests/:id/approve',requireUser,async(req,res,next)=>{
  try{
    const request=await transitionRequest(req.params.id,req.employee,'APPROVAL',req.body.decision,req.body.reason||'');
    let detail=await regenerateForm(request.id);
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

    if(approved){
      await cleanupApprovedRequestFiles(detail);
      detail=await getRequestDetail(request.id);
    }

    res.json({ok:true,status:detail.request.status});
  }catch(e){next(e)}
});

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