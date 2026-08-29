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
  pool,pingDb,listActiveEmployees,getEmployee,listRequestsForEmployee,createExpenseRequest
} from './db.js';

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const app=express();
const PORT=Number(process.env.PORT || 8080);
const PgStore=connectPgSimple(session);
const DEV_AUTH=String(process.env.DEV_AUTH || 'true').toLowerCase()==='true';
const DATA_DIR=process.env.PDF_DIR || '/data/pdfs';
const MAX_EVIDENCE_MB=Number(process.env.MAX_EVIDENCE_MB || 15);
const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:MAX_EVIDENCE_MB*1024*1024,files:64}
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
  cookie:{httpOnly:true,sameSite:'lax',secure:false,maxAge:8*60*60*1000}
}));

app.get('/health', async (req,res)=>{
  try {
    const db=await pingDb();
    res.json({ok:true,app:'Metrotech ERF',db:true,time:db.now,devAuth:DEV_AUTH});
  } catch (e) {
    res.status(503).json({ok:false,error:e.message});
  }
});

app.get('/api/dev/users', async (req,res)=>{
  if(!DEV_AUTH) return res.sendStatus(404);
  res.json({users:await listActiveEmployees()});
});

app.post('/api/dev/login', async (req,res)=>{
  if(!DEV_AUTH) return res.sendStatus(404);
  const employee=await getEmployee(String(req.body.email||''));
  if(!employee) return res.status(404).json({error:'Employee not found'});
  req.session.user={email:employee.email};
  res.json({ok:true,employee});
});

app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));

async function requireUser(req,res,next){
  try{
    const email=req.session?.user?.email;
    if(!email) return res.status(401).json({error:'Authentication required'});
    const employee=await getEmployee(email);
    if(!employee) return res.status(403).json({error:'Employee is inactive or missing'});
    req.employee=employee;
    next();
  }catch(e){next(e)}
}

app.get('/api/me',requireUser,async(req,res)=>{
  const requests=await listRequestsForEmployee(req.employee);
  res.json({employee:req.employee,requests});
});

app.post('/api/requests',requireUser,upload.any(),async(req,res,next)=>{
  try{
    if(req.employee.role!=='REQUESTOR') return res.status(403).json({error:'Only Requestor can create an expense request.'});

    let rawItems;
    try { rawItems=JSON.parse(String(req.body.items||'[]')); }
    catch { return res.status(400).json({error:'Invalid payment data.'}); }

    if(!Array.isArray(rawItems)||!rawItems.length) return res.status(400).json({error:'Add at least one payment.'});
    if(rawItems.length>16) return res.status(400).json({error:'Maximum 16 payments per request.'});

    const files=req.files||[];
    const totalBytes=files.reduce((s,f)=>s+f.size,0);
    if(totalBytes>MAX_EVIDENCE_MB*1024*1024) {
      return res.status(400).json({error:`Total evidence exceeds ${MAX_EVIDENCE_MB} MB.`});
    }

    const items=rawItems.map((x,i)=>{
      const category=String(x.category||'').trim();
      const purpose=String(x.purpose||'').trim();
      const paymentDate=String(x.paymentDate||'').trim();
      const amount=Math.round(Number(x.amount));
      const itemFiles=files.filter(f=>f.fieldname===`evidence_${i}`);
      if(!category||!purpose||!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)||!Number.isFinite(amount)||amount<=0){
        throw Object.assign(new Error(`Payment #${i+1} is incomplete.`),{status:400});
      }
      if(!itemFiles.length){
        throw Object.assign(new Error(`Payment #${i+1} requires evidence.`),{status:400});
      }
      return {
        category,purpose,paymentDate,amount,
        evidenceNames:itemFiles.map(f=>f.originalname)
      };
    });

    const request=await createExpenseRequest(req.employee,items);
    const requestDir=path.join(DATA_DIR,String(request.id),'evidence-original');
    await fs.mkdir(requestDir,{recursive:true});

    for(const f of files){
      const safeName=String(f.originalname||'evidence').replace(/[^a-zA-Z0-9._-]+/g,'_');
      const idx=String(f.fieldname).replace('evidence_','');
      const out=path.join(requestDir,`${String(Number(idx)+1).padStart(2,'0')}-${Date.now()}-${safeName}`);
      await fs.writeFile(out,f.buffer);
    }

    res.status(201).json({
      ok:true,
      requestId:request.id,
      refNo:request.ref_no,
      requestDate:request.request_date,
      total:Number(request.total),
      status:request.status,
      revision:request.revision
    });
  }catch(e){next(e)}
});

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
