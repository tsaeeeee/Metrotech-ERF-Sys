import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, pingDb, listActiveEmployees, getEmployee, listRequestsForEmployee } from './db.js';

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const app=express();
const PORT=Number(process.env.PORT || 8080);
const PgStore=connectPgSimple(session);
const DEV_AUTH=String(process.env.DEV_AUTH || 'true').toLowerCase()==='true';

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
    secure:false,
    maxAge:8*60*60*1000
  }
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

app.post('/api/logout',(req,res)=>{
  req.session.destroy(()=>res.json({ok:true}));
});

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

app.use(express.static(path.join(__dirname,'../public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(err.status||500).json({error:err.message||'Internal server error'});
});

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`Metrotech ERF listening on :${PORT} | DEV_AUTH=${DEV_AUTH}`);
});
