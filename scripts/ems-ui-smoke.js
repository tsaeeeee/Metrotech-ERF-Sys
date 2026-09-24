import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

// Use the real HTML, styles and browser extensions with deterministic API fixtures.
// The HTTP smoke test separately exercises the real server and PostgreSQL workflow.
const assets={
  '/':{type:'text/html',files:['index.html']},
  '/styles.css':{type:'text/css',files:['styles.css']},
  '/app.js':{type:'application/javascript',files:['app.js','request-type.js']},
  '/ecf-admin.js':{type:'application/javascript',files:['ecf-admin.js','ecf-profile.js']},
  '/ems.js':{type:'application/javascript',files:['ems.js']}
};
const server=http.createServer(async(req,res)=>{
  const asset=assets[new URL(req.url,'http://localhost').pathname];
  if(!asset){res.writeHead(404).end();return}
  try{
    const content=await Promise.all(asset.files.map(file=>
      fs.readFile(new URL('../public/'+file,import.meta.url),'utf8')));
    res.writeHead(200,{'Content-Type':asset.type}).end(content.join('\n\n'));
  }catch(error){res.writeHead(500).end(String(error))}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
const errors=[];

function employee(role,ecfRole=role){
  return {
    email:ecfRole.toLowerCase()+'@example.test',username:ecfRole.toLowerCase(),
    name:'UI '+ecfRole,role,ecfRole,employee_id:'UI001',department:'Testing',
    location:'Jakarta',division:'Engineering',signature_file:'fixture.png',
    must_change_password:false,must_upload_signature:false
  };
}
function row(form_type,status,id){
  return {
    id,ref_no:form_type+'-'+id,form_type,request_type:'EXPENSE',
    requester_email:'requestor@example.test',request_date:'2026-09-23',
    employee_name:'UI Requestor',total:100000,status,revision:1,last_rejection_reason:''
  };
}
const revisionRow={
  ...row('ECF','CHECK_REJECTED','revision'),
  service_order_number:'SO-ORIGINAL',last_rejection_reason:'Update receipt'
};

async function session(user,{signedIn=true}={}){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(String(error)));
  let active=signedIn?user:null;
  const writes=[];
  await page.route(origin+'/api/**',async route=>{
    const request=route.request();
    const path=new URL(request.url()).pathname;
    const method=request.method();
    const reply=(data,status=200)=>route.fulfill({
      status,contentType:'application/json',body:JSON.stringify(data)
    });
    if(path==='/api/auth-mode') return reply({localLoginEnabled:true,googleAuthReady:false});
    if(path==='/api/login'){active=user;return reply({ok:true})}
    if(path==='/api/logout'){active=null;return reply({ok:true})}
    if(!active) return reply({error:'Sign in required'},401);
    if(method!=='GET') writes.push({path,method,body:request.postData()||''});
    if(path==='/api/me'){
      const stage=active.ecfRole==='CHECKER'?'PENDING_CHECK':
        active.ecfRole==='APPROVER'?'PENDING_APPROVAL':'PENDING_REVIEW';
      const tasks=[row('ECF',stage,'task')];
      if(stage!=='PENDING_CHECK') tasks.push(row('ERF',stage,'task'));
      return reply({
        employee:active,
        requests:active.role==='REQUESTOR'?[revisionRow]:tasks,
        myRequests:active.role==='REQUESTOR'?[revisionRow]:[],
        tasks:active.role==='ADMIN'||['REQUESTOR','NONE'].includes(active.ecfRole)?[]:tasks
      });
    }
    if(path==='/api/ems/dashboard') return reply({totals:[],trend:[],categories:[]});
    if(path==='/api/admin/users') return reply({
      users:[{...employee('REQUESTOR'),active:true,has_signature:true}]
    });
    if(path==='/api/admin/app-settings') return reply({
      settings:{appBaseUrl:'https://ems.example.test',ecfRoles:[]},readiness:{}
    });
    if(path==='/api/requests/revision') return reply({
      request:revisionRow,
      items:[{line_no:1,category:'Travel Expense',purpose:'Claim revision',
        payment_date:'2026-09-23',amount:100000,evidence_names:['proof.pdf']}],
      actions:[],documents:{}
    });
    if(path==='/api/requests/revision/revise') return reply({
      refNo:'ECF-revision',status:'PENDING_CHECK',requestId:'revision'
    });
    if(path==='/api/requests'&&method==='POST') return reply({
      refNo:'ERF-new',status:'PENDING_REVIEW',requestId:'new'
    });
    if(path==='/api/requests/new') return reply({
      request:{reviewer_name:'Reviewer',approver_name:'Approver'}
    });
    errors.push('Unexpected API: '+method+' '+path);
    return reply({error:'Unexpected API'},404);
  });
  await page.goto(origin);
  await page.locator(signedIn?'#emsHome':'#loginCard').waitFor({state:'visible'});
  return {page,context,writes};
}
async function login(page){
  await page.locator('#loginUsername').fill('fixture');
  await page.locator('#loginPassword').fill('fixture-password');
  await page.locator('#loginBtn').click();
  await page.locator('#emsHome').waitFor({state:'visible'});
}
async function checkAdmin(page){
  assert(await page.locator('#emsAdminNav').isVisible(),'Admin dropdown must be visible');
  assert(!await page.locator('#emsTransactionsNav').isVisible(),'Admin must not see transactions');
  assert(!await page.locator('#emsActivityNav').isVisible(),'Admin must not see personal activity');
  assert(!/profile/i.test(await page.locator('#emsNav').innerText()),'Profile belongs in account menu');
  await page.locator('#adminUsersTab').click();
  await page.locator('#adminUsersTable').waitFor({state:'visible'});
  assert.match(await page.locator('#adminUsersTable').innerText(),/ECF Access/);
  await page.getByRole('button',{name:'+ Create User',exact:true}).click();
  assert(await page.locator('#adminEcfAccess').isVisible(),'User form must retain ECF access');
  await page.evaluate(()=>closeAdminUserModal());
  await page.locator('#adminAppTab').click();
  await page.waitForFunction(()=>document.querySelector('#appBaseUrl').value==='https://ems.example.test');
  assert(await page.locator('#appSmtpHost').isVisible(),'App Management must retain SMTP settings');
}
async function addPayment(page,purpose,{evidence=false}={}){
  await page.locator('#categoryButton').click();
  await page.locator('#categoryMenu').getByRole('button',{name:'Travel Expense',exact:true}).click();
  await page.locator('#purpose').fill(purpose);
  await page.locator('#paymentDate').fill('2026-09-23');
  await page.locator('#amount').fill('100000');
  if(evidence) await page.locator('#evidence').setInputFiles({
    name:'proof.pdf',mimeType:'application/pdf',buffer:Buffer.from('UI fixture')
  });
  await page.locator('#addPaymentBtn').click();
}
async function navigate(page,view){
  await page.locator('#emsNav [data-ems-view="'+view+'"]').click();
}

try{
  browser=await chromium.launch({
    headless:true,executablePath:process.env.EMS_UI_CHROMIUM_PATH||undefined
  });
  const admin=await session(employee('ADMIN'));
  await checkAdmin(admin.page);
  await admin.page.reload();
  await admin.page.locator('#emsHome').waitFor({state:'visible'});
  await checkAdmin(admin.page);
  const sidebar=await admin.page.locator('#emsNav').boundingBox();
  assert.equal(sidebar.x,0,'Desktop sidebar must sit against the left edge');
  assert.equal(sidebar.y+sidebar.height,1000,'Sidebar must extend to viewport bottom');
  await admin.page.locator('#emsAdminNav summary').click();
  assert(!await admin.page.locator('#adminUsersTab').isVisible(),'Dropdown must collapse');
  await admin.page.locator('#emsAdminNav summary').click();
  await admin.page.setViewportSize({width:390,height:844});
  await admin.page.locator('#emsSidebarToggle').click();
  await admin.page.waitForFunction(()=>Math.abs(document.querySelector('#emsNav').getBoundingClientRect().left)<1);
  await admin.page.locator('#adminUsersTab').click();
  assert.equal(await admin.page.locator('#emsSidebarToggle').getAttribute('aria-expanded'),'false');
  await admin.context.close();

  const freshAdmin=await session(employee('ADMIN'),{signedIn:false});
  await login(freshAdmin.page);
  await checkAdmin(freshAdmin.page);
  await freshAdmin.context.close();
  console.log('Admin login, refresh and sidebar checks passed.');

  for(const ecfRole of ['CHECKER','REVIEWER','APPROVER']){
    const account=await session(employee(ecfRole==='CHECKER'?'REQUESTOR':ecfRole,ecfRole));
    for(let pass=0;pass<2;pass++){
      if(pass){
        await account.page.reload();
        await account.page.locator('#emsHome').waitFor({state:'visible'});
      }
      assert(!await account.page.locator('#emsAdminNav').isVisible());
      await navigate(account.page,'ecf');
      assert(await account.page.locator('#requestQueueCard').isVisible(),ecfRole+' needs a claim queue');
      assert.match(await account.page.locator('#tbody').innerText(),/ECF-task/);
      assert(!await account.page.locator('#requestForm').isVisible(),ecfRole+' must not get a claim form');
      assert.equal(await account.page.locator('#tbody .recall').count(),0,'Only owners can recall');
      await navigate(account.page,'tasks');
      assert.match(await account.page.locator('#emsTaskRows').innerText(),/ECF-task/);
    }
    await account.context.close();
  }
  const noEcf=await session(employee('REQUESTOR','NONE'));
  assert(!await noEcf.page.locator('[data-ems-view="ecf"]').isVisible());
  await noEcf.context.close();
  console.log('Checker, Reviewer, Approver and No Access navigation checks passed.');

  const requestor=await session(employee('REQUESTOR'));
  const page=requestor.page;
  await navigate(page,'erf');
  assert.equal(await page.locator('#requestTypeControl').count(),0,'ERF must not offer reimbursement creation');
  await addPayment(page,'ERF draft');
  await page.locator('#purpose').fill('Unfinished ERF payment');
  await page.locator('#evidence').setInputFiles({
    name:'unfinished.pdf',mimeType:'application/pdf',buffer:Buffer.from('Unfinished UI fixture')
  });
  await navigate(page,'ecf');
  assert(!/ERF draft/.test(await page.locator('#paymentBody').innerText()));
  assert.equal(await page.locator('#purpose').inputValue(),'');
  await page.locator('#emsServiceOrder').fill('SO-DRAFT');
  await addPayment(page,'ECF draft',{evidence:true});
  await navigate(page,'erf');
  assert.match(await page.locator('#paymentBody').innerText(),/ERF draft/);
  assert(!/ECF draft/.test(await page.locator('#paymentBody').innerText()));
  assert.equal(await page.locator('#purpose').inputValue(),'Unfinished ERF payment');
  assert.equal(await page.locator('#evidence').evaluate(input=>input.files[0]?.name),'unfinished.pdf');
  await navigate(page,'ecf');
  assert.match(await page.locator('#paymentBody').innerText(),/ECF draft/);
  assert.equal(await page.locator('#emsServiceOrder').inputValue(),'SO-DRAFT');

  await navigate(page,'requests');
  await page.locator('#tbody').getByRole('button',{name:'Revise',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#emsServiceOrder').value==='SO-ORIGINAL');
  await page.locator('#emsServiceOrder').fill('SO-EDITED');
  await navigate(page,'erf');
  assert(!await page.locator('#revisionBanner').isVisible(),'ECF revision must not leak into ERF');
  await page.locator('#submitExpenseBtn').click();
  await page.waitForFunction(()=>!emsSubmitting&&!payments.length);
  const submitted=requestor.writes.find(item=>item.path==='/api/requests');
  assert(submitted?.body.includes('ERF draft'),'ERF submission must use its own draft');
  assert(!requestor.writes.some(item=>item.path.endsWith('/revise')),'ERF must not revise the ECF draft');

  await navigate(page,'ecf');
  assert(await page.locator('#revisionBanner').isVisible(),'ECF revision must survive switching');
  assert.match(await page.locator('#requestFormTitle').innerText(),/ECF-revision/);
  assert.equal(await page.locator('#emsServiceOrder').inputValue(),'SO-EDITED');
  await page.locator('#submitExpenseBtn').click();
  await page.waitForFunction(()=>!emsSubmitting&&!payments.length);
  const revised=requestor.writes.find(item=>item.path==='/api/requests/revision/revise');
  assert(revised?.body.includes('SO-EDITED'),'Revised Service Order must be submitted');
  await addPayment(page,'Discard on logout',{evidence:true});
  await page.locator('#userMenuBtn').click();
  await page.locator('#userMenu').getByRole('button',{name:'Logout',exact:true}).click();
  await page.locator('#loginCard').waitFor({state:'visible'});
  await login(page);
  await navigate(page,'ecf');
  assert(!/Discard on logout/.test(await page.locator('#paymentBody').innerText()));
  assert.equal(await page.locator('#emsServiceOrder').inputValue(),'');
  await requestor.context.close();
  assert.deepEqual(errors,[],'No uncaught browser errors or unexpected API requests');
  console.log('EMS_UI_SMOKE_OK');
}catch(error){
  console.error('Browser errors:',errors);
  throw error;
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
