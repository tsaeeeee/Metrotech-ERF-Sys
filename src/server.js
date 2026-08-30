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
  createManagedEmployee,updateManagedEmployee,listRequestsForEmployee,createExpenseRequest,
  getRequestDetail,setDocumentPaths,transitionRequest,recallExpenseRequest,reviseExpenseRequest
} from './db.js';
import { buildEvidencePdf,buildFormPdf } from './documents.js';
import { sendWorkflowMail } from './mailer.js';
import { configureAuth,passport } from './auth.js';

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const app=express();
const PORT=Number(process.env.PORT || 8080);
const PgStore=connectPgSimple(session);
const DEV_AUTH=String(process.env.DEV_AUTH || 'true').toLowerCase()==='true';
const GOOGLE_AUTH_READY=!DEV_AUTH &&
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL);
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

app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false}));
app.use(session({
  store:new PgStore({pool,createTableIfMissing:true}),
  secret:process.env.SESSION_SECRET || 'dev-only-change-me',
  resave:false,
  saveUninitialized:false,
  cookie:{
    httpOnly:true,
    sameSite:'lax',
    secure:String(process.env.COOKIE_SECURE || 'false').toLowerCase()==='true',
    maxAge:8*60*60*1000
  }
}));

if(GOOGLE_AUTH_READY){
  configureAuth();
  app.use(passport.initialize());
  app.use(passport.session());
}

app.get('/health', async (req,res)=>{
  try {
    const db=await pingDb();
    res.json({ok:true,app:'Metrotech ERF',db:true,time:db.now,devAuth:DEV_AUTH,googleAuthReady:GOOGLE_AUTH_READY,pdfMode:String(process.env.PDF_MODE||'mock')});
  } catch (e) {
    res.status(503).json({ok:false,error:e.message});
  }
});

app.get('/api/auth-mode',(req,res)=>{
  res.json({devAuth:DEV_AUTH,googleAuthReady:GOOGLE_AUTH_READY});
});

app.get('/auth/google',(req,res,next)=>{
  if(!GOOGLE_AUTH_READY) return res.status(503).send('Google Workspace authentication is not configured.');
  return passport.authenticate('google',{scope:['profile','email']})(req,res,next);
});

app.get('/auth/google/callback',(req,res,next)=>{
  if(!GOOGLE_AUTH_READY) return res.redirect('/?auth=unavailable');
  return passport.authenticate('google',{failureRedirect:'/?auth=failed'})(req,res,()=>res.redirect('/'));
});

app.post('/api/login', async (req,res,next)=>{
  try{
    if(!DEV_AUTH) return res.status(404).json({error:'Local login is disabled.'});
    const username=String(req.body.username||'').trim();
    const password=String(req.body.password||'');
    const employee=await authenticateLocalUser(username,password);
    if(!employee) return res.status(401).json({error:'Invalid username or password.'});

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

function parseItemsAndFiles(req){
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
    if(!itemFiles.length) throw Object.assign(new Error(`Payment #${i+1} requires evidence.`),{status:400});
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

async function generateSubmissionDocs(requestId,files){
  const detail=await getRequestDetail(requestId);
  if(!detail) throw new Error('Request disappeared after creation.');
  const dir=path.join(DATA_DIR,String(requestId),`r${detail.request.revision}`);
  const evidencePath=path.join(dir,'evidence.pdf');
  const formPath=path.join(dir,`form-${detail.request.status.toLowerCase()}.pdf`);
  await buildEvidencePdf({request:detail.request,items:detail.items,files,outPath:evidencePath});
  await buildFormPdf({request:detail.request,items:detail.items,outPath:formPath});
  await setDocumentPaths(requestId,formPath,evidencePath);
  return {detail:await getRequestDetail(requestId),formPath,evidencePath};
}

async function regenerateForm(requestId){
  const detail=await getRequestDetail(requestId);
  const dir=path.join(DATA_DIR,String(requestId),`r${detail.request.revision}`);
  const formPath=path.join(dir,`form-${detail.request.status.toLowerCase()}.pdf`);
  await buildFormPdf({request:detail.request,items:detail.items,outPath:formPath});
  await setDocumentPaths(requestId,formPath,null);
  return await getRequestDetail(requestId);
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

app.post('/api/requests',requireUser,upload.any(),async(req,res,next)=>{
  try{
    if(req.employee.role!=='REQUESTOR') return res.status(403).json({error:'Only Requestor can create an expense request.'});
    const {items,files}=parseItemsAndFiles(req);
    const request=await createExpenseRequest(req.employee,items);
    await persistOriginals(request.id,1,files);
    const {detail}=await generateSubmissionDocs(request.id,files);
    await sendWorkflowMail({
      event:'SUBMITTED',request:detail.request,to:detail.request.reviewer_email,
      subject:`[ERF] ${detail.request.ref_no} pending review`,
      text:`${detail.request.employee_name} submitted ${detail.request.ref_no} for review.`
    });
    res.status(201).json({ok:true,requestId:request.id,refNo:request.ref_no,status:'PENDING_REVIEW',revision:1});
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
      subject:`[ERF] ${detail.request.ref_no} recalled by requestor`,
      text:`${detail.request.ref_no} was recalled by ${req.employee.name} and no longer requires review.`
    });
    res.json({ok:true,status:detail.request.status,refNo:detail.request.ref_no});
  }catch(e){next(e)}
});

app.post('/api/requests/:id/revise',requireUser,upload.any(),async(req,res,next)=>{
  try{
    if(req.employee.role!=='REQUESTOR') return res.status(403).json({error:'Only Requestor can revise a request.'});
    const {items,files}=parseItemsAndFiles(req);
    const request=await reviseExpenseRequest(req.params.id,req.employee,items);
    await persistOriginals(request.id,request.revision,files);
    const {detail}=await generateSubmissionDocs(request.id,files);
    await sendWorkflowMail({
      event:'REVISED',request:detail.request,to:detail.request.reviewer_email,
      subject:`[ERF] ${detail.request.ref_no} revised and pending review`,
      text:`${detail.request.employee_name} submitted revision ${detail.request.revision} of ${detail.request.ref_no}.`
    });
    res.json({ok:true,requestId:request.id,refNo:request.ref_no,status:'PENDING_REVIEW',revision:request.revision});
  }catch(e){next(e)}
});

app.get('/api/requests/:id',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail) return res.status(404).json({error:'Request not found'});
    if(!canAccess(req.employee,detail.request)) return res.status(403).json({error:'Access denied'});
    const {form_pdf_path,evidence_pdf_path,...safeRequest}=detail.request;
    res.json({request:safeRequest,items:detail.items,actions:detail.actions,documents:{form:!!form_pdf_path,evidence:!!evidence_pdf_path}});
  }catch(e){next(e)}
});

app.get('/api/requests/:id/form',requireUser,async(req,res,next)=>{
  try{
    const detail=await getRequestDetail(req.params.id);
    if(!detail||!canAccess(req.employee,detail.request)) return res.status(404).end();
    if(!detail.request.form_pdf_path) return res.status(404).json({error:'Form PDF is not available.'});
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
      return res.status(404).json({error:'Final Form PDF is not available.'});
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
    await sendWorkflowMail({
      event:approved?'REVIEW_APPROVED':'REVIEW_REJECTED',request:detail.request,
      to:approved?detail.request.approver_email:detail.request.requester_email,
      subject:approved?`[ERF] ${detail.request.ref_no} pending final approval`:`[ERF] ${detail.request.ref_no} rejected by reviewer`,
      text:approved?`${detail.request.ref_no} was reviewed by ${req.employee.name} and is ready for final approval.`
        :`${detail.request.ref_no} was rejected by ${req.employee.name}. Reason: ${req.body.reason}`
    });
    res.json({ok:true,status:detail.request.status});
  }catch(e){next(e)}
});

app.post('/api/requests/:id/approve',requireUser,async(req,res,next)=>{
  try{
    const request=await transitionRequest(req.params.id,req.employee,'APPROVAL',req.body.decision,req.body.reason||'');
    const detail=await regenerateForm(request.id);
    const approved=detail.request.status==='APPROVED';
    const attachments=approved?[
      {filename:`${detail.request.ref_no}.pdf`,path:detail.request.form_pdf_path}
    ]:[];
    await sendWorkflowMail({
      event:approved?'FINAL_APPROVED':'APPROVAL_REJECTED',request:detail.request,
      to:detail.request.requester_email,
      cc:approved?[detail.request.reviewer_email,process.env.FINAL_APPROVED_CC]:detail.request.reviewer_email,
      subject:approved?`[ERF] ${detail.request.ref_no} approved`:`[ERF] ${detail.request.ref_no} rejected by approver`,
      text:approved?`${detail.request.ref_no} has been approved by ${req.employee.name}.`
        :`${detail.request.ref_no} was rejected by ${req.employee.name}. Reason: ${req.body.reason}`,
      attachments
    });
    res.json({ok:true,status:detail.request.status});
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
  console.log(`Metrotech ERF listening on :${PORT} | DEV_AUTH=${DEV_AUTH}`);
});
