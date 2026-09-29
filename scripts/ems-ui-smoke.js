import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

// Exercise the shipped HTML/CSS/scripts in a real browser. API fixtures keep
// these navigation regressions independent of database seeding and mail setup.
const publicDir=new URL('../public/',import.meta.url);
const assets={
  '/':['index.html'],
  '/styles.css':['styles.css'],
  '/ems-theme.css':['ems-theme.css'],
  '/app.js':['app.js','request-type.js'],
  '/ecf-admin.js':['ecf-admin.js','ecf-profile.js'],
  '/ems.js':['ems.js']
};
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(['/assets/metrotech-logo.png','/assets/metrotech-favicon.svg'].includes(pathname)){
    try{
      const body=await fs.readFile(new URL('.'+pathname,publicDir));
      res.setHeader('Content-Type',pathname.endsWith('.svg')?'image/svg+xml':'image/png');
      res.end(body);
    }catch{res.writeHead(404);res.end()}
    return;
  }
  const files=assets[pathname];
  if(!files){res.writeHead(404);res.end();return}
  try{
    const body=(await Promise.all(files.map(file=>fs.readFile(new URL(file,publicDir),'utf8')))).join('\n\n');
    res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html');
    res.end(body);
  }catch(error){res.writeHead(500);res.end(error.message)}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const errors=[];
let browser;

function employee(role,ecfRole=role){
  return {email:`${ecfRole.toLowerCase()}@example.test`,name:`UI ${ecfRole}`,role,ecfRole,
    employee_id:'UI-001',department:'Operations',location:'Jakarta',division:'Service',
    signature_file:'/test/signature.png',must_change_password:false,must_upload_signature:false};
}
function row(form_type,status,id){
  return {id,ref_no:`${form_type}-${id}`,form_type,request_type:'EXPENSE',status,
    requester_email:'requestor@example.test',employee_name:'UI Requestor',
    reviewer_email:'reviewer@example.test',approver_email:'approver@example.test',
    request_date:'2026-09-23',total:100000,revision:1,last_rejection_reason:''};
}
const revisionRow={...row('ECF','CHECK_REJECTED','revision'),last_rejection_reason:'Update receipt',
  service_order_number:'SO-ORIGINAL'};

async function session(user,{signedIn=true,dashboard={totals:[],trend:[],categories:[]}}={}){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  let active=signedIn?user:null;
  const writes=[];
  await page.route(`${origin}/api/**`,async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    const method=request.method();
    let data={},status=200;
    if(method!=='GET')writes.push({path,method,body:request.postData()||''});
    if(path==='/api/auth-mode')data={localLoginEnabled:true,googleAuthReady:false};
    else if(path==='/api/login'){active=user;data={employee:user}}
    else if(path==='/api/logout'){active=null}
    else if(!active){status=401;data={error:'Authentication required'}}
    else if(path==='/api/me'){
      const stage=user.ecfRole==='CHECKER'?'PENDING_CHECK':user.role==='APPROVER'?'PENDING_APPROVAL':'PENDING_REVIEW';
      const tasks=[row('ECF',stage,'task')];
      if(stage!=='PENDING_CHECK')tasks.push(row('ERF',stage,'erf-task'));
      data={employee:active,requests:user.role==='REQUESTOR'||
        (user.role==='NONE'&&user.ecfRole==='REQUESTOR')?[revisionRow]:tasks,
        tasks:user.ecfRole==='REQUESTOR'||user.ecfRole==='NONE'||user.role==='ADMIN'?[]:tasks,
        history:[row('ECF','APPROVED','history')],
        myRequests:user.role==='REQUESTOR'||
          (user.role==='NONE'&&user.ecfRole==='REQUESTOR')?[revisionRow]:[]};
    }else if(path==='/api/ems/dashboard')data=dashboard;
    else if(path==='/api/requests/task' || path==='/api/requests/history'){
      const state=path.endsWith('history')?'APPROVED':user.ecfRole==='CHECKER'?'PENDING_CHECK':
        user.role==='REVIEWER'?'PENDING_REVIEW':'PENDING_APPROVAL';
      data={request:{...row('ECF',state,path.split('/').pop()),checker_name:'UI Checker',
        reviewer_name:'UI Reviewer',approver_name:'UI Approver'},items:[],documents:{},
        actions:[{action:'CHECK_APPROVED',actor_name:'UI Checker',actor_role:'REQUESTOR',created_at:'2026-09-25'}]};
    }
    else if(path==='/api/admin/users')data={users:[{...employee('REQUESTOR'),active:true,username:'ui-requestor',has_signature:true}]};
    else if(path==='/api/admin/app-settings')data={settings:{appBaseUrl:'https://ems.example.test',ecfRoles:[]},readiness:{}};
    else if(path==='/api/requests/revision')data={request:revisionRow,items:[{
      line_no:1,category:'Travel Expense',purpose:'Claim revision',payment_date:'2026-09-23',amount:100000,evidence_names:['proof.pdf']
    }],actions:[],documents:{}};
    else if(path==='/api/requests/revision/revise')data={refNo:revisionRow.ref_no,status:'PENDING_CHECK',requestId:'revision'};
    else if(path==='/api/requests'&&method==='POST')data={refNo:'ERF-new',status:'PENDING_REVIEW',requestId:'new'};
    else if(path==='/api/ecf/claims'&&method==='POST')data={refNo:'ECF-new',status:'PENDING_CHECK',requestId:'new'};
    else if(path==='/api/requests/new')data={request:{reviewer_name:'Reviewer',approver_name:'Approver'}};
    else {status=404;data={error:`Unexpected UI API ${method} ${path}`};errors.push(data.error)}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(origin);
  if(signedIn)await page.locator('#emsHome').waitFor({state:'visible'});
  else await page.locator('#loginCard').waitFor({state:'visible'});
  return {context,page,writes};
}

async function login(page){
  await page.locator('#loginUsername').fill('ui-user');
  await page.locator('#loginPassword').fill('ui-fixture-password');
  await page.locator('#loginBtn').click();
  await page.locator('#emsHome').waitFor({state:'visible'});
}

async function assertAdmin(page){
  assert(await page.locator('#emsAdminNav').isVisible(),'Admin navigation must be visible.');
  assert(!await page.locator('#emsTransactionsNav').isVisible(),'Admin must not see transactions.');
  assert(!await page.locator('#emsActivityNav').isVisible(),'Admin must not see activity.');
  assert.equal(await page.locator('#emsNav').getByText('My Profile',{exact:true}).count(),0);
  await page.locator('#adminUsersTab').click();
  await page.locator('#adminUsersTable').waitFor({state:'visible'});
  assert((await page.locator('#adminUsersTable').innerText()).includes('ECF Access'));
  await page.getByRole('button',{name:'+ Create User',exact:true}).click();
  assert(await page.locator('#adminEcfAccessButton').isVisible());
  await page.locator('#adminRoleButton').click();
  await page.locator('#adminRoleMenu [data-value="NONE"]').click();
  assert.equal(await page.locator('#adminRoleLabel').innerText(),'No Access');
  await page.locator('#adminEcfAccessButton').click();
  await page.locator('#adminEcfAccessMenu [data-value="CHECKER"]').click();
  assert.equal(await page.locator('#adminEcfAccessLabel').innerText(),'Checker');
  assert.equal(await page.locator('#adminEcfAccess').inputValue(),'CHECKER');
  await page.locator('#adminEcfAccessButton').click();
  await page.locator('#adminEcfAccessMenu [data-value="REQUESTOR"]').click();
  await page.evaluate(()=>closeAdminUserModal());
  await page.locator('#adminAppTab').click();
  await page.waitForFunction(()=>document.querySelector('#appBaseUrl').value==='https://ems.example.test');
  assert(await page.locator('#appSmtpHost').isVisible());
}

async function addPayment(page,purpose,{evidence=false}={}){
  await page.locator('#categoryButton').click();
  await page.locator('#categoryMenu [data-value="Travel Expense"]').click();
  await page.locator('#purpose').fill(purpose);
  await page.locator('#paymentDate').fill('2026-09-23');
  await page.locator('#amount').fill('100000');
  if(evidence)await page.locator('#evidence').setInputFiles({name:'proof.pdf',mimeType:'application/pdf',buffer:Buffer.from('UI fixture')});
  await page.locator('#addPaymentBtn').click();
}

try{
  browser=await chromium.launch({headless:true,
    executablePath:process.env.EMS_UI_CHROMIUM_PATH||undefined});
  const admin=await session(employee('ADMIN','NONE'));
  await assertAdmin(admin.page);
  assert.equal(await admin.page.locator('#roleTitle').innerText(),'Admin Dashboard');
  assert(!await admin.page.locator('#profile').isVisible(),'Admin has no employee details on Dashboard.');
  await admin.page.reload();
  await admin.page.locator('#emsHome').waitFor({state:'visible'});
  await assertAdmin(admin.page);
  const geometry=await admin.page.locator('#emsNav').boundingBox();
  assert.equal(geometry.x,0,'Navigation must stay in the left sidebar.');
  assert.equal(geometry.y,60,'Sidebar must start below the header.');
  assert.equal(geometry.y+geometry.height,1000,'Sidebar must reach the viewport bottom.');
  await admin.page.locator('#emsAdminNav summary').click();
  assert(!await admin.page.locator('#adminUsersTab').isVisible(),'Desktop navigation groups must collapse.');
  await admin.page.locator('#emsAdminNav summary').click();
  assert.equal(await admin.page.locator('[data-ems-view="admin-app"]').getAttribute('aria-current'),'page');
  assert.equal(await admin.page.locator('.ems-nav .active').evaluate(el=>getComputedStyle(el).color),'rgb(11, 55, 104)','Keep Metrotech navy.');
  assert(await admin.page.locator('.ems-nav .active').evaluate(el=>getComputedStyle(el,'::before').maskImage!=='none'),'Navigation icons must render.');
  assert(await admin.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Desktop must not overflow.');
  await admin.page.setViewportSize({width:390,height:844});
  await admin.page.locator('#emsSidebarToggle').click();
  await admin.page.waitForFunction(()=>Math.abs(document.querySelector('#emsNav').getBoundingClientRect().left)<1);
  await admin.page.locator('#emsAdminNav summary').click();
  assert(!await admin.page.locator('#adminUsersTab').isVisible(),'Mobile administration must collapse.');
  await admin.page.locator('#emsAdminNav summary').click();
  await admin.page.locator('#adminUsersTab').click();
  assert.equal(await admin.page.locator('#emsSidebarToggle').getAttribute('aria-expanded'),'false');
  assert(await admin.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile must not overflow.');
  await admin.page.locator('#emsSidebarToggle').click();
  await admin.page.locator('#emsAdminNav summary').click();
  await admin.page.setViewportSize({width:1440,height:1000});
  assert(!await admin.page.locator('#adminUsersTab').isVisible(),'Keep the disclosure choice when resizing.');
  await admin.page.locator('#emsAdminNav summary').click();
  await admin.page.locator('#adminUsersTab').waitFor({state:'visible'});
  assert.equal(await admin.page.locator('#emsSidebarToggle').getAttribute('aria-expanded'),'false');
  await admin.context.close();

  const chartUser=await session(employee('REQUESTOR','REQUESTOR'),{dashboard:{
    totals:[{form_type:'ERF',status:'APPROVED',amount:2000000,count:2},
      {form_type:'ECF',status:'APPROVED',amount:1000000,count:1},
      {form_type:'ECF',status:'PENDING_CHECK',amount:250000,count:1}],
    trend:[{month:'2026-08',form_type:'ERF',amount:800000},{month:'2026-09',form_type:'ERF',amount:1200000},
      {month:'2026-09',form_type:'ECF',amount:1000000}],
    categories:[{category:'Akamai Expenses – Deployment',form_type:'ERF',amount:1200000},
      {category:'Bank Action',form_type:'ECF',amount:1000000}]
  }});
  await chartUser.page.locator('#emsTrend svg').waitFor();
  assert.equal(await chartUser.page.locator('#emsDistribution svg circle').count(),2);
  assert((await chartUser.page.locator('#emsMetrics').innerText()).includes('2 approved requests'));
  await chartUser.page.locator('.ems-chart-data summary').click();
  assert.equal(await chartUser.page.locator('.ems-chart-data tbody tr').count(),6);
  const firstMonth=await chartUser.page.locator('.ems-chart-data tbody tr').first().innerText();
  assert(/\d{4}-\d{2}/.test(firstMonth),'Monthly chart must include dated amounts.');
  await chartUser.page.locator('.ems-chart-data summary').click();
  if(process.env.EMS_UI_SCREENSHOTS){
    await fs.mkdir(process.env.EMS_UI_SCREENSHOTS,{recursive:true});
    await chartUser.page.screenshot({path:`${process.env.EMS_UI_SCREENSHOTS}/dashboard.png`,fullPage:true});
  }
  await chartUser.page.setViewportSize({width:390,height:844});
  assert(await chartUser.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Charts must fit on mobile.');
  if(process.env.EMS_UI_SCREENSHOTS)
    await chartUser.page.screenshot({path:`${process.env.EMS_UI_SCREENSHOTS}/dashboard-mobile.png`,fullPage:true});
  await chartUser.page.setViewportSize({width:1440,height:1000});
  await chartUser.page.locator('[data-ems-view="erf"]').click();
  if(process.env.EMS_UI_SCREENSHOTS)
    await chartUser.page.screenshot({path:`${process.env.EMS_UI_SCREENSHOTS}/request-form.png`,fullPage:true});
  await chartUser.context.close();

  const fresh=await session(employee('ADMIN','NONE'),{signedIn:false});
  await login(fresh.page);
  await assertAdmin(fresh.page);
  await fresh.page.locator('#adminUsersTab').click();
  await fresh.page.getByRole('button',{name:'+ Create User',exact:true}).click();
  await fresh.page.locator('#adminRoleButton').click();
  await fresh.page.locator('#adminRoleMenu [data-value="NONE"]').click();
  for(const [field,value] of [
    ['adminName','ECF Only'],['adminEmail','ecf-only@example.test'],
    ['adminUsername','ecf-only'],['adminPassword','ci-password'],
    ['adminEmployeeId','UI-007'],['adminDepartment','Operations'],
    ['adminLocation','Jakarta'],['adminDivision','Service']
  ]) await fresh.page.locator('#'+field).fill(value);
  await fresh.page.locator('#saveAdminUserBtn').click();
  await fresh.page.locator('#adminUserModal').waitFor({state:'hidden'});
  assert(fresh.writes.some(write=>write.path==='/api/admin/users' &&
    JSON.parse(write.body).role==='NONE'),'Admin must save ERF No Access.');
  assert(fresh.writes.some(write=>write.path==='/api/admin/app-settings' &&
    JSON.parse(write.body).ecfRoleAssignment?.role==='REQUESTOR'),
    'Admin must save independent ECF Requestor access.');
  await fresh.context.close();

  for(const [role,ecfRole,title,erf,ecf,requests,tasks] of [
    ['REQUESTOR','NONE','Requestor Dashboard',true,false,true,false],
    ['REQUESTOR','REQUESTOR','Requestor Dashboard',true,true,true,false],
    ['REQUESTOR','CHECKER','Requestor & Checker Dashboard',true,false,true,true],
    ['NONE','REQUESTOR','ECF Requestor Dashboard',false,true,true,false],
    ['NONE','CHECKER','Checker Dashboard',false,false,false,true],
    ['NONE','NONE','Dashboard',false,false,false,false],
    ['REVIEWER','REVIEWER','Reviewer Dashboard',false,false,false,true],
    ['APPROVER','APPROVER','Approver Dashboard',false,false,false,true]
  ]){
    const actor=await session(employee(role,ecfRole));
    assert(!await actor.page.locator('#emsAdminNav').isVisible());
    for(let attempt=0;attempt<2;attempt++){
      assert.equal(await actor.page.locator('#roleTitle').innerText(),title);
      assert((await actor.page.locator('#roleTitle').boundingBox()).y <
        (await actor.page.getByText('EMS Overview',{exact:true}).boundingBox()).y,
        'Role title must be above EMS Overview.');
      assert.equal(await actor.page.locator('#emsHome #profile').count(),1);
      assert.equal(await actor.page.locator('#workflowDashboard #profile').count(),0);
      const profile=actor.page.locator('#emsHome #profile');
      assert(await profile.isVisible(),'Employee details belong on Dashboard.');
      assert((await profile.innerText()).includes('UI-001'));
      assert((await profile.innerText()).includes('Operations'));
      assert((await profile.boundingBox()).y <
        (await actor.page.getByText('EMS Overview',{exact:true}).boundingBox()).y,
        'Employee details must precede EMS Overview.');
      assert.equal(await actor.page.locator('#emsTransactionsNav').isVisible(),erf||ecf);
      assert.equal(await actor.page.locator('[data-ems-view="erf"]').isVisible(),erf);
      assert.equal(await actor.page.locator('[data-ems-view="ecf"]').isVisible(),ecf);
      assert.equal(await actor.page.locator('[data-ems-view="requests"]').isVisible(),requests);
      assert.equal(await actor.page.locator('[data-ems-view="tasks"]').isVisible(),tasks);
      assert.equal(await actor.page.locator('[data-ems-view="history"]').isVisible(),requests||tasks);
      await actor.page.waitForFunction(()=>document.querySelector('#emsMetrics').textContent.trim()!=='');
      const metricLabels=await actor.page.locator('#emsMetrics').innerText();
      assert.equal(metricLabels.includes('Approved ERF'),role!=='NONE',
        'Dashboard must follow ERF access.');
      assert.equal(metricLabels.includes('Approved ECF'),ecfRole!=='NONE',
        'Dashboard must follow ECF access.');
      if(ecf){
        await actor.page.locator('[data-ems-view="ecf"]').click();
        assert(await actor.page.locator('#requestQueueCard').isVisible(),'ECF Requestor needs an ECF queue.');
        assert(await actor.page.locator('#requestForm').isVisible(),'ECF Requestor can create claims.');
      }
      if(tasks){
        await actor.page.locator('[data-ems-view="tasks"]').click();
        assert((await actor.page.locator('#emsTaskRows').innerText()).includes('ECF-task'));
        assert(!await actor.page.locator('#requestForm').isVisible(),'Work happens in Activity, without a transaction form.');
        assert(!await actor.page.locator('#decisionHistoryCard').isVisible(),'History must be separate from My Tasks.');
      }
      if(requests||tasks){
        await actor.page.locator('[data-ems-view="history"]').click();
        assert(await actor.page.locator('#decisionHistoryCard').isVisible());
        assert(!await actor.page.locator('#emsTasks').isVisible());
        assert.equal(await actor.page.locator('#emsTasks #decisionHistoryCard').count(),0);
        assert((await actor.page.locator('#decisionHistoryBody').innerText()).includes('ECF-history'));
        await actor.page.locator('#decisionHistoryBody').getByRole('button',{name:'Open',exact:true}).click();
        await actor.page.waitForFunction(()=>emsDetail?.id==='history');
        assert((await actor.page.locator('#auditTrail').innerText()).includes('UI Checker · CHECKER'),
          'Old Checker audit entries must display CHECKER without updating stored records.');
        await actor.page.evaluate(()=>closeDetail());
      }
      if(attempt===0){await actor.page.reload();await actor.page.locator('#emsHome').waitFor({state:'visible'})}
    }
    await actor.context.close();
  }

  for(const [role,ecfRole,endpoint] of [['NONE','CHECKER','check'],
    ['REVIEWER','REVIEWER','review'],['APPROVER','APPROVER','approve']]){
    for(const decision of ['APPROVE','REJECT']){
      const actor=await session(employee(role,ecfRole));
      const page=actor.page;
      await page.locator('[data-ems-view="tasks"]').click();
      await page.locator('#emsTaskRows button').first().click();
      await page.waitForFunction(()=>emsDetail?.id==='task');
      await page.locator('#decisionReason').fill('Test reason');
      const button=page.locator(decision==='APPROVE'?'#approveBtn':'#rejectBtn');
      let count=0;
      for(const fail of [true,false]){
        let release;
        const gate=new Promise(resolve=>{release=resolve});
        const url=`${origin}/api/requests/task/${endpoint}`;
        await page.route(url,async route=>{
          count++;
          await gate;
          await route.fulfill({status:fail?500:200,contentType:'application/json',
            body:JSON.stringify(fail?{error:'Test action failure'}:{status:'APPROVED'})});
        });
        await button.click();
        await page.waitForFunction(()=>document.querySelector('[aria-busy="true"].decision-action-loading'));
        assert.equal(await button.getAttribute('aria-busy'),'true');
        assert(await page.locator('#approveBtn').isDisabled());
        assert(await page.locator('#rejectBtn').isDisabled());
        await page.evaluate(value=>sendDecision(value),decision);
        release();
        await page.waitForFunction(()=>!emsChecking && !sigDecisionBusy);
        assert.equal(await button.getAttribute('aria-busy'),null,'Loading must clear after both success and failure.');
        if(fail){
          assert(await page.locator('#detailModal').isVisible());
          assert(!await button.isDisabled(),'Failed actions must be retryable.');
        }else assert(!await page.locator('#detailModal').isVisible());
        await page.unroute(url);
      }
      assert.equal(count,2,'Double clicks must not submit duplicate decisions.');
      await actor.context.close();
    }
  }

  const ecfOnly=await session(employee('NONE','REQUESTOR'));
  await ecfOnly.page.locator('[data-ems-view="ecf"]').click();
  await addPayment(ecfOnly.page,'Independent ECF',{evidence:true});
  let releaseSubmit;
  const submitGate=new Promise(resolve=>{releaseSubmit=resolve});
  await ecfOnly.page.route(`${origin}/api/ecf/claims`,async route=>{
    await submitGate;
    await route.fallback();
  });
  await ecfOnly.page.locator('#submitExpenseBtn').click();
  assert.equal(await ecfOnly.page.locator('#submitExpenseBtn').getAttribute('aria-busy'),'true');
  assert(await ecfOnly.page.locator('#submitExpenseBtn').isDisabled());
  releaseSubmit();
  await ecfOnly.page.waitForFunction(()=>!emsSubmitting && payments.length===0);
  assert.equal(await ecfOnly.page.locator('#submitExpenseBtn').getAttribute('aria-busy'),null);
  assert(ecfOnly.writes.some(write=>write.path==='/api/ecf/claims' &&
    write.body.includes('Independent ECF')));
  assert(!ecfOnly.writes.some(write=>write.path==='/api/requests' && write.method==='POST'));
  await ecfOnly.context.close();

  const requestor=await session(employee('REQUESTOR'));
  const page=requestor.page;
  await page.locator('[data-ems-view="erf"]').click();
  await addPayment(page,'ERF draft');
  await page.locator('#purpose').fill('Unfinished ERF payment');
  await page.locator('#evidence').setInputFiles({name:'unfinished.pdf',mimeType:'application/pdf',buffer:Buffer.from('UI fixture')});
  await page.locator('[data-ems-view="ecf"]').click();
  assert(!(await page.locator('#paymentBody').innerText()).includes('ERF draft'));
  assert.equal(await page.locator('#purpose').inputValue(),'');
  await page.locator('#emsServiceOrder').fill('SO-DRAFT');
  await addPayment(page,'ECF draft',{evidence:true});
  await page.locator('[data-ems-view="erf"]').click();
  assert((await page.locator('#paymentBody').innerText()).includes('ERF draft'));
  assert(!(await page.locator('#paymentBody').innerText()).includes('ECF draft'));
  assert.equal(await page.locator('#purpose').inputValue(),'Unfinished ERF payment');
  assert.equal(await page.locator('#evidence').evaluate(el=>el.files[0]?.name),'unfinished.pdf');
  await page.locator('[data-ems-view="ecf"]').click();
  assert((await page.locator('#paymentBody').innerText()).includes('ECF draft'));
  assert.equal(await page.locator('#emsServiceOrder').inputValue(),'SO-DRAFT');

  await page.locator('[data-ems-view="requests"]').click();
  await page.locator('#tbody').getByRole('button',{name:'Revise',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#emsServiceOrder').value==='SO-ORIGINAL');
  await page.locator('#emsServiceOrder').fill('SO-EDITED');
  await page.locator('[data-ems-view="erf"]').click();
  assert(!await page.locator('#revisionBanner').isVisible(),'ECF revision must not remain active in ERF.');
  await page.locator('#submitExpenseBtn').click();
  await page.waitForFunction(()=>document.querySelector('#submitExpenseBtn').disabled&&document.querySelector('#paymentBody').innerText.includes('No payments'));
  await page.waitForFunction(()=>!emsSubmitting);
  assert(requestor.writes.some(write=>write.path==='/api/requests'&&write.body.includes('ERF draft')));
  assert(!requestor.writes.some(write=>write.path.endsWith('/revise')));
  await page.locator('[data-ems-view="ecf"]').click();
  assert(await page.locator('#revisionBanner').isVisible());
  assert((await page.locator('#requestFormTitle').innerText()).includes('ECF-revision'));
  assert.equal(await page.locator('#emsServiceOrder').inputValue(),'SO-EDITED');
  await page.locator('#submitExpenseBtn').click();
  await page.waitForFunction(()=>document.querySelector('#submitExpenseBtn').disabled&&document.querySelector('#paymentBody').innerText.includes('No payments'));
  await page.waitForFunction(()=>!emsSubmitting);
  assert(requestor.writes.some(write=>write.path==='/api/requests/revision/revise'&&write.body.includes('SO-EDITED')));

  await addPayment(page,'Discard on logout',{evidence:true});
  await page.locator('#userMenuBtn').click();
  await page.locator('#userMenu').getByRole('button',{name:'Logout',exact:true}).click();
  await page.locator('#loginCard').waitFor({state:'visible'});
  await login(page);
  await page.locator('[data-ems-view="ecf"]').click();
  assert(!(await page.locator('#paymentBody').innerText()).includes('Discard on logout'));
  assert.equal(await page.locator('#emsServiceOrder').inputValue(),'');
  await requestor.context.close();
  assert.deepEqual(errors,[],'Browser must not produce runtime errors or unexpected API calls.');
  console.log('EMS_UI_SMOKE_OK');
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
