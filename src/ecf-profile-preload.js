import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool,getEmployee } from './db.js';
import { ECF_BANK_DIRECTORY,findEcfBank } from './ecf-bank-directory.js';

const INSTALL_KEY=Symbol.for('metrotech.ecfPaymentProfileRoutesInstalled');
const originalListen=express.application.listen;
const originalStatic=express.static;

// Keep index.html untouched: when the existing page asks for ecf-admin.js,
// append the ECF payment-profile UI extension to that same script response.
express.static=function(root,options){
  const middleware=originalStatic(root,options);
  const isPublicRoot=path.basename(String(root||''))==='public';
  if(!isPublicRoot) return middleware;

  return async function ecfExtendedStatic(req,res,next){
    if(req.path==='/ecf-admin.js'){
      try{
        const [adminExtension,profileExtension]=await Promise.all([
          fs.readFile(path.join(root,'ecf-admin.js'),'utf8'),
          fs.readFile(path.join(root,'ecf-profile.js'),'utf8')
        ]);
        res.type('application/javascript').send(`${adminExtension}\n\n${profileExtension}`);
        return;
      }catch(error){
        console.error('Failed to load ECF profile UI extension:',error);
      }
    }
    return middleware(req,res,next);
  };
};

function paymentProfilePayload(row={}){
  return {
    paymentTo:String(row.payment_to||''),
    bankName:String(row.bank_name||''),
    bankCode:String(row.bank_code||''),
    accountNumber:String(row.account_number||'')
  };
}

function normalizePaymentProfile(input={}){
  const profile={
    paymentTo:String(input.paymentTo||'').trim(),
    bankName:String(input.bankName||'').trim(),
    bankCode:String(input.bankCode||'').trim(),
    accountNumber:String(input.accountNumber||'').trim()
  };

  if(profile.paymentTo.length>160)
    throw Object.assign(new Error('Payment To is too long.'),{status:400});
  if(profile.bankName.length>80)
    throw Object.assign(new Error('Bank Name is too long.'),{status:400});
  if(profile.bankCode.length>20)
    throw Object.assign(new Error('Bank Code is too long.'),{status:400});
  if(profile.accountNumber.length>80)
    throw Object.assign(new Error('Account Number is too long.'),{status:400});

  const hasBank=Boolean(profile.bankName||profile.bankCode);
  if(hasBank && !findEcfBank(profile.bankName,profile.bankCode))
    throw Object.assign(new Error('Choose a bank from the available bank list.'),{status:400});

  return profile;
}

async function profileEmployee(req){
  const email=req.session?.user?.email || req.user?.email;
  if(!email) throw Object.assign(new Error('Authentication required'),{status:401});
  const employee=await getEmployee(email);
  if(!employee) throw Object.assign(new Error('Employee is inactive or missing'),{status:403});
  if(employee.role==='ADMIN')
    throw Object.assign(new Error('Admin profile is managed separately.'),{status:400});
  return employee;
}

async function readPaymentProfile(email){
  const {rows}=await pool.query(
    `select payment_to,bank_name,bank_code,account_number
     from employee_payment_profiles
     where lower(employee_email)=lower($1)
     limit 1`,
    [email]
  );
  return paymentProfilePayload(rows[0]||{});
}

async function savePaymentProfile(email,input){
  const profile=normalizePaymentProfile(input);
  const {rows}=await pool.query(
    `insert into employee_payment_profiles(
       employee_email,payment_to,bank_name,bank_code,account_number,updated_at
     ) values($1,$2,$3,$4,$5,now())
     on conflict(employee_email) do update
     set payment_to=excluded.payment_to,
         bank_name=excluded.bank_name,
         bank_code=excluded.bank_code,
         account_number=excluded.account_number,
         updated_at=now()
     returning payment_to,bank_name,bank_code,account_number`,
    [email,profile.paymentTo,profile.bankName,profile.bankCode,profile.accountNumber]
  );
  return paymentProfilePayload(rows[0]||{});
}

function sendRouteError(res,error){
  console.error(error);
  res.status(error?.status||500).json({error:error?.message||'Internal server error'});
}

function installPaymentProfileRoutes(app){
  if(app[INSTALL_KEY]) return;
  app[INSTALL_KEY]=true;

  // These non-GET API routes are installed immediately before listen().
  // The main server's JSON/session middleware has already been registered.
  app.post('/api/profile/payment/banks/read',async(req,res)=>{
    try{
      await profileEmployee(req);
      res.json({banks:ECF_BANK_DIRECTORY});
    }catch(error){sendRouteError(res,error)}
  });

  app.post('/api/profile/payment/read',async(req,res)=>{
    try{
      const employee=await profileEmployee(req);
      res.json({paymentProfile:await readPaymentProfile(employee.email)});
    }catch(error){sendRouteError(res,error)}
  });

  app.put('/api/profile/payment',async(req,res)=>{
    try{
      const employee=await profileEmployee(req);
      const paymentProfile=await savePaymentProfile(employee.email,req.body||{});
      res.json({ok:true,paymentProfile});
    }catch(error){sendRouteError(res,error)}
  });
}

express.application.listen=function(...args){
  installPaymentProfileRoutes(this);
  return originalListen.apply(this,args);
};
