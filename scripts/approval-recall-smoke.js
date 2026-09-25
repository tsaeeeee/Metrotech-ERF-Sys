import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';
import {pool,getRequestDetail,setDocumentPaths,recallApprovedExpenseRequest} from '../src/db.js';
import {approvalArchivePath} from '../src/approval-archive.js';
import {saveAppSettings} from '../src/settings.js';

export async function testApprovalRecall({request,requestor,reviewer,reviewer2,approver,admin}){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'erf-recall-'));
  const oldDir=process.env.PDF_DIR;
  process.env.PDF_DIR=temp;
  let server;
  let logs='';
  try{
    const pdf=await PDFDocument.create();
    pdf.addPage().drawText('Previously approved packet');
    const original=Buffer.from(await pdf.save());
    const packet=path.join(temp,'legacy-approved.pdf');
    await fs.writeFile(packet,original);
    await setDocumentPaths(request.id,packet,'');
    await assert.rejects(recallApprovedExpenseRequest(request.id,requestor,'Test'),e=>e.status===403);
    await assert.rejects(recallApprovedExpenseRequest(request.id,reviewer,'Test'),e=>e.status===403);
    await assert.rejects(recallApprovedExpenseRequest(request.id,{...approver,email:'other@example.test'},'Test'),e=>e.status===403);
    await assert.rejects(recallApprovedExpenseRequest(request.id,approver,'  '),e=>e.status===400);
    await setDocumentPaths(request.id,path.join(temp,'missing.pdf'),'');
    await assert.rejects(recallApprovedExpenseRequest(request.id,approver,'Missing archive'));
    assert.equal((await getRequestDetail(request.id)).request.status,'APPROVED');
    await setDocumentPaths(request.id,packet,'');

    await saveAppSettings({smtpEnabled:false,localLoginEnabled:true,cookieSecure:false},admin.email);
    server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:'18997',PDF_MODE:'mock',MAIL_GATEWAY_URL:''},stdio:['ignore','pipe','pipe']});
    server.stdout.on('data',chunk=>{logs+=chunk});
    server.stderr.on('data',chunk=>{logs+=chunk});
    const base='http://127.0.0.1:18997';
    let ready=false;
    for(let i=0;i<100;i++){
      try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}
      if(server.exitCode!==null) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(ready,`Server did not start: ${logs}`);
    const login=async username=>{
      const res=await fetch(`${base}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'ci-only'})});
      assert.equal(res.status,200,await res.text());
      return res.headers.get('set-cookie').split(';')[0];
    };
    const [requestorCookie,reviewerCookie,reviewer2Cookie,approverCookie]=await Promise.all([
      login(requestor.username),login(reviewer.username),login(reviewer2.username),login(approver.username)
    ]);
    const call=(cookie,suffix,method='GET',body)=>fetch(`${base}/api/requests/${request.id}${suffix}`,{
      method,headers:{cookie,...(body instanceof FormData?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})
    });
    assert.equal((await call(requestorCookie,'/recall','POST',{reason:'Unauthorized'})).status,409);
    assert.equal((await call(reviewerCookie,'/recall','POST',{reason:'Unauthorized'})).status,403);
    assert.equal((await call(approverCookie,'/recall','POST',{reason:'  '})).status,400);
    const attempts=await Promise.all([1,2].map(()=>call(approverCookie,'/recall','POST',{reason:'Correct the amount'})));
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
    const detail=await (await call(requestorCookie,'')).json();
    assert.equal(detail.request.status,'RECALLED');
    assert.equal(detail.documents.form,false);
    assert.equal(detail.items[0].evidenceReusable,false);
    assert.equal(detail.actions.filter(a=>a.action==='APPROVAL_RECALLED').length,1);
    const recall=detail.actions.find(a=>a.action==='APPROVAL_RECALLED');
    assert.equal(recall.reason,'Correct the amount');
    assert.equal(recall.from_status,'APPROVED');
    assert.equal(recall.actor_role,'APPROVER');
    assert(detail.actions.some(a=>a.action==='FINAL_APPROVED'));
    assert.equal((await call(requestorCookie,'/form/download')).status,409);
    assert.equal((await call(requestorCookie,'/form')).status,404);
    const archiveUrl=`/approval-archive/${request.revision}`;
    const archived=await call(requestorCookie,archiveUrl);
    assert.equal(archived.status,200);
    assert(archived.headers.get('content-disposition').includes('SUPERSEDED'));
    assert.deepEqual(Buffer.from(await archived.arrayBuffer()),original);
    assert.equal((await call(reviewer2Cookie,archiveUrl)).status,404);
    assert.equal((await call(requestorCookie,'/approval-archive/999')).status,404);
    const values=[{category:'Testing',purpose:'Revised after approval recall',paymentDate:'2026-09-25',amount:120000,sourceLineNo:1}];
    const missing=new FormData();missing.set('items',JSON.stringify(values));
    assert.equal((await call(requestorCookie,'/revise','POST',missing)).status,400);
    const revision=new FormData();revision.set('items',JSON.stringify(values));
    revision.set('evidence_0',new Blob([original],{type:'application/pdf'}),'evidence.pdf');
    const submitted=await call(requestorCookie,'/revise','POST',revision);
    assert.equal(submitted.status,200,await submitted.text());
    const revised=await getRequestDetail(request.id);
    assert.equal(revised.request.status,'PENDING_REVIEW');
    assert.equal(revised.request.revision,request.revision+1);
    assert.equal((await call(approverCookie,'/recall','POST',{reason:'Wrong state'})).status,409);
    const assignedReviewer=revised.request.reviewer_email===reviewer.email?reviewerCookie:reviewer2Cookie;
    const reviewed=await call(assignedReviewer,'/review','POST',{decision:'APPROVE'});
    assert.equal(reviewed.status,200,await reviewed.text());
    const approved=await call(approverCookie,'/approve','POST',{decision:'APPROVE'});
    assert.equal(approved.status,200,await approved.text());
    const second=await (await call(requestorCookie,'')).json();
    assert.equal(second.request.status,'APPROVED');
    assert.equal(second.items[0].evidenceReusable,true);
    const secondRecall=await call(approverCookie,'/recall','POST',{reason:'Second correction'});
    assert.equal(secondRecall.status,200,await secondRecall.text());
    assert.deepEqual(await fs.readFile(approvalArchivePath(request)),original);
    const secondArchive=await call(requestorCookie,`/approval-archive/${request.revision+1}`);
    assert.equal(secondArchive.status,200);
    const emails=await pool.query("select mail_to,mail_cc from email_log where request_id=$1 and event='APPROVAL_RECALLED'",[request.id]);
    assert.equal(emails.rows.length,2);
    assert(emails.rows.every(row=>row.mail_to.includes(requestor.email)&&row.mail_cc.includes(reviewer.email)));
    console.log('APPROVAL_RECALL_SMOKE_OK');
  }catch(error){
    console.error(logs);
    throw error;
  }finally{
    if(server&&server.exitCode===null){const ended=once(server,'exit');server.kill();await ended;}
    if(oldDir===undefined) delete process.env.PDF_DIR; else process.env.PDF_DIR=oldDir;
    await fs.rm(temp,{recursive:true,force:true});
  }
}
