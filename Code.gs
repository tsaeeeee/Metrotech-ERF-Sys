function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(CFG.APP_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.SAMEORIGIN);
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function setupSystem() {
  var props = PropertiesService.getScriptProperties();
  var dataId = props.getProperty(PROP.DATA_SPREADSHEET_ID);
  var folderId = props.getProperty(PROP.OUTPUT_FOLDER_ID);
  var dataSs;

  if (!dataId) {
    dataSs = SpreadsheetApp.create('Metrotech Expense Approval System Data');
    dataId = dataSs.getId();
    props.setProperty(PROP.DATA_SPREADSHEET_ID, dataId);
  } else {
    dataSs = SpreadsheetApp.openById(dataId);
  }

  ensureSheet_(dataSs, 'Employees', ['Email','Name','Employee ID','Department','Location','Division','Role','Signature File ID','Active']);
  ensureSheet_(dataSs, 'Requests', ['Request ID','Ref No','Request Date','Requester Email','Employee Name','Employee ID','Department','Location','Division','Total','Status','Revision','Form PDF File ID','Evidence PDF File ID','Request Folder ID','Last Rejection Reason','Reviewer Email','Approver Email','Created At','Updated At']);
  ensureSheet_(dataSs, 'RequestItems', ['Request ID','Revision','Line No','Category','Purpose of Payment','Payment Date','Amount','Evidence Names']);
  ensureSheet_(dataSs, 'Actions', ['Request ID','Ref No','Revision','Actor Email','Actor Name','Actor Role','Action','From Status','To Status','Reason','Timestamp']);
  ensureSheet_(dataSs, 'Counters', ['Counter Date','Last Sequence']);
  ensureSheet_(dataSs, 'EmailLog', ['Request ID','Ref No','Event','To','Cc','Sent At','Status','Error']);

  if (!folderId) {
    var folder = DriveApp.createFolder('Metrotech Expense Approval Files');
    folderId = folder.getId();
    props.setProperty(PROP.OUTPUT_FOLDER_ID, folderId);
  }

  return {
    ok: true,
    dataSpreadsheetId: dataId,
    outputFolderId: folderId,
    templateSpreadsheetId: CFG.TEMPLATE_SPREADSHEET_ID,
    webAppUrl: ScriptApp.getService().getUrl() || ''
  };
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#D9E2F3');
    sh.setFrozenRows(1);
  }
  return sh;
}

function getDataSs_() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP.DATA_SPREADSHEET_ID);
  if (!id) throw new Error('System is not initialized. Run setupSystem() once as administrator.');
  return SpreadsheetApp.openById(id);
}

function getOutputFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty(PROP.OUTPUT_FOLDER_ID);
  if (!id) throw new Error('Output folder is not configured. Run setupSystem() once.');
  return DriveApp.getFolderById(id);
}

function currentEmployee_() {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) throw new Error('Unable to identify your Google Workspace account. Check the web-app deployment identity settings.');
  if (CFG.ALLOWED_DOMAIN && !email.endsWith('@' + CFG.ALLOWED_DOMAIN.toLowerCase())) throw new Error('Please sign in using your company Google Workspace account.');

  var sh = getDataSs_().getSheetByName('Employees');
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][0] || '').trim().toLowerCase();
    var active = String(rows[i][8] == null ? 'TRUE' : rows[i][8]).toLowerCase();
    if (rowEmail === email && ['false','0','inactive','no'].indexOf(active) === -1) {
      return {
        email: rowEmail,
        name: String(rows[i][1] || ''),
        employeeId: String(rows[i][2] || ''),
        department: String(rows[i][3] || ''),
        location: String(rows[i][4] || ''),
        division: String(rows[i][5] || ''),
        role: String(rows[i][6] || '').trim().toUpperCase(),
        signatureFileId: String(rows[i][7] || '').trim()
      };
    }
  }
  throw new Error('Your account is not registered in Employees master data.');
}

function requireRole_(role) {
  var user = currentEmployee_();
  if (user.role !== role) throw new Error('Access denied for this role.');
  return user;
}

function actorByNameRole_(name, role) {
  var sh = getDataSs_().getSheetByName('Employees');
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var active = String(rows[i][8] == null ? 'TRUE' : rows[i][8]).toLowerCase();
    if (String(rows[i][1] || '').trim() === name && String(rows[i][6] || '').trim().toUpperCase() === role && ['false','0','inactive','no'].indexOf(active) === -1) {
      return {
        email: String(rows[i][0] || '').trim().toLowerCase(),
        name: String(rows[i][1] || ''),
        employeeId: String(rows[i][2] || ''),
        department: String(rows[i][3] || ''),
        location: String(rows[i][4] || ''),
        division: String(rows[i][5] || ''),
        role: role,
        signatureFileId: String(rows[i][7] || '').trim()
      };
    }
  }
  throw new Error('Required workflow actor not found: ' + name + ' (' + role + ').');
}

function workflowActors_() {
  return {
    reviewer: actorByNameRole_(CFG.REVIEWER_NAME, ROLE.REVIEWER),
    approver: actorByNameRole_(CFG.APPROVER_NAME, ROLE.APPROVER)
  };
}

function assertSignature_(employee) {
  if (!employee.signatureFileId) throw new Error('Signature is not configured for ' + employee.name + '.');
}

function bootstrap() {
  var user = currentEmployee_();
  return {
    appName: CFG.APP_NAME,
    user: user,
    maxItems: CFG.MAX_ITEMS,
    maxEvidenceTotalMb: CFG.MAX_EVIDENCE_TOTAL_MB,
    today: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    dashboard: dashboardFor_(user)
  };
}

function refreshDashboard() {
  return dashboardFor_(currentEmployee_());
}

function dashboardFor_(user) {
  var all = getAllRequests_();
  var rows = [];
  if (user.role === ROLE.REQUESTOR) rows = all.filter(function(r){ return r.requesterEmail === user.email; }).sort(sortNewest_);
  if (user.role === ROLE.REVIEWER) rows = all.filter(function(r){ return r.status === STATUS.PENDING_REVIEW; }).sort(sortOldest_);
  if (user.role === ROLE.APPROVER) rows = all.filter(function(r){ return r.status === STATUS.PENDING_APPROVAL; }).sort(sortOldest_);
  return { role: user.role, requests: rows.map(publicSummary_) };
}

function submitExpense(payload) {
  var requestor = requireRole_(ROLE.REQUESTOR);
  assertSignature_(requestor);
  var items = normalizeItems_(payload && payload.items);
  var evidence = evidenceBlobFromPayload_(payload);
  var actors = workflowActors_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var req;
  var isRevision = false;

  try {
    if (payload && payload.revisionRequestId) {
      req = getRequestRecord_(payload.revisionRequestId);
      if (req.requesterEmail !== requestor.email) throw new Error('You cannot revise another employee request.');
      if ([STATUS.REVIEW_REJECTED, STATUS.APPROVAL_REJECTED].indexOf(req.status) === -1) throw new Error('This request is not open for revision.');

      var oldStatus = req.status;
      isRevision = true;
      req.revision += 1;
      req.total = sumItems_(items);
      req.status = STATUS.PENDING_REVIEW;
      req.lastReason = '';
      req.updatedAt = new Date();
      req.employee = requestor;
      updateRequestCore_(req);
      appendItems_(req.requestId, req.revision, items);
      logAction_(req, requestor, 'REVISED_AND_RESUBMITTED', oldStatus, STATUS.PENDING_REVIEW, '');
    } else {
      var now = new Date();
      req = {
        requestId: Utilities.getUuid(),
        refNo: nextRefNo_(now),
        requestDate: now,
        requesterEmail: requestor.email,
        employee: requestor,
        total: sumItems_(items),
        status: STATUS.PENDING_REVIEW,
        revision: 1,
        formPdfFileId: '',
        evidencePdfFileId: '',
        requestFolderId: createRequestFolder_().getId(),
        lastReason: '',
        reviewerEmail: actors.reviewer.email,
        approverEmail: actors.approver.email,
        createdAt: now,
        updatedAt: now
      };
      appendNewRequest_(req);
      appendItems_(req.requestId, req.revision, items);
      logAction_(req, requestor, 'SUBMITTED', '', STATUS.PENDING_REVIEW, '');
    }
  } finally {
    lock.releaseLock();
  }

  var folder = DriveApp.getFolderById(req.requestFolderId);
  var evidenceName = req.refNo + '-R' + req.revision + '-EVIDENCE.pdf';
  var evidenceFile = folder.createFile(evidence.setName(evidenceName));
  req.evidencePdfFileId = evidenceFile.getId();

  var formFile = generateFormPdf_(req, items, 'REQUESTOR');
  req.formPdfFileId = formFile.getId();
  updateRequestFiles_(req);

  notifyReviewer_(req, formFile, evidenceFile, isRevision);
  return publicSummary_(req);
}

function normalizeItems_(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Add at least one payment.');
  if (items.length > CFG.MAX_ITEMS) throw new Error('Maximum ' + CFG.MAX_ITEMS + ' payments per request.');
  return items.map(function(x, i) {
    var category = String(x.category || '').trim();
    var purpose = String(x.purpose || '').trim();
    var paymentDate = String(x.paymentDate || '').trim();
    var amount = Math.round(Number(x.amount));
    var evidenceNames = Array.isArray(x.evidenceNames) ? x.evidenceNames : [];
    if (!category || !purpose || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate) || !Number.isFinite(amount) || amount <= 0) throw new Error('Invalid payment #' + (i + 1) + '.');
    if (!evidenceNames.length) throw new Error('Payment #' + (i + 1) + ' requires evidence.');
    return { category: category, purpose: purpose, paymentDate: paymentDate, amount: amount, evidenceNames: evidenceNames };
  });
}

function evidenceBlobFromPayload_(payload) {
  var base64 = String(payload && payload.evidencePdfBase64 || '');
  if (!base64) throw new Error('Merged evidence PDF is required.');
  var bytes = Utilities.base64Decode(base64);
  if (bytes.length > CFG.MAX_EVIDENCE_TOTAL_MB * 1024 * 1024) throw new Error('Evidence exceeds ' + CFG.MAX_EVIDENCE_TOTAL_MB + ' MB.');
  return Utilities.newBlob(bytes, MimeType.PDF, 'evidence.pdf');
}

function sumItems_(items) {
  return items.reduce(function(sum, x){ return sum + Number(x.amount || 0); }, 0);
}

function reviewRequest(payload) {
  var reviewer = requireRole_(ROLE.REVIEWER);
  assertSignature_(reviewer);
  var action = String(payload && payload.action || '').toUpperCase();
  var reason = String(payload && payload.reason || '').trim();
  if (['APPROVE','REJECT'].indexOf(action) === -1) throw new Error('Invalid action.');
  if (action === 'REJECT' && !reason) throw new Error('Rejection reason is required.');

  var req = getRequestRecord_(payload.requestId);
  if (req.status !== STATUS.PENDING_REVIEW) throw new Error('Request is no longer pending review.');

  if (action === 'REJECT') {
    var lock = LockService.getScriptLock(); lock.waitLock(30000);
    try {
      req = getRequestRecord_(payload.requestId);
      if (req.status !== STATUS.PENDING_REVIEW) throw new Error('Request is no longer pending review.');
      req.status = STATUS.REVIEW_REJECTED;
      req.lastReason = reason;
      req.updatedAt = new Date();
      updateRequestCore_(req);
      logAction_(req, reviewer, 'REJECTED_BY_REVIEWER', STATUS.PENDING_REVIEW, STATUS.REVIEW_REJECTED, reason);
    } finally { lock.releaseLock(); }
    notifyRejectedByReviewer_(req, reviewer, reason);
    return publicSummary_(req);
  }

  var items = getCurrentItems_(req.requestId, req.revision);
  var signedForm = generateFormPdf_(req, items, 'REVIEWER');

  var lock2 = LockService.getScriptLock(); lock2.waitLock(30000);
  try {
    req = getRequestRecord_(payload.requestId);
    if (req.status !== STATUS.PENDING_REVIEW) throw new Error('Request is no longer pending review.');
    req.status = STATUS.PENDING_APPROVAL;
    req.formPdfFileId = signedForm.getId();
    req.lastReason = '';
    req.updatedAt = new Date();
    updateRequestCore_(req);
    updateRequestFiles_(req);
    logAction_(req, reviewer, 'APPROVED_BY_REVIEWER', STATUS.PENDING_REVIEW, STATUS.PENDING_APPROVAL, '');
  } finally { lock2.releaseLock(); }

  notifyApprover_(req, signedForm, DriveApp.getFileById(req.evidencePdfFileId));
  return publicSummary_(req);
}

function approveRequest(payload) {
  var approver = requireRole_(ROLE.APPROVER);
  assertSignature_(approver);
  var action = String(payload && payload.action || '').toUpperCase();
  var reason = String(payload && payload.reason || '').trim();
  if (['APPROVE','REJECT'].indexOf(action) === -1) throw new Error('Invalid action.');
  if (action === 'REJECT' && !reason) throw new Error('Rejection reason is required.');

  var req = getRequestRecord_(payload.requestId);
  if (req.status !== STATUS.PENDING_APPROVAL) throw new Error('Request is no longer pending approval.');

  if (action === 'REJECT') {
    var lock = LockService.getScriptLock(); lock.waitLock(30000);
    try {
      req = getRequestRecord_(payload.requestId);
      if (req.status !== STATUS.PENDING_APPROVAL) throw new Error('Request is no longer pending approval.');
      req.status = STATUS.APPROVAL_REJECTED;
      req.lastReason = reason;
      req.updatedAt = new Date();
      updateRequestCore_(req);
      logAction_(req, approver, 'REJECTED_BY_APPROVER', STATUS.PENDING_APPROVAL, STATUS.APPROVAL_REJECTED, reason);
    } finally { lock.releaseLock(); }
    notifyRejectedByApprover_(req, approver, reason);
    return publicSummary_(req);
  }

  var items = getCurrentItems_(req.requestId, req.revision);
  var finalForm = generateFormPdf_(req, items, 'APPROVER');

  var lock2 = LockService.getScriptLock(); lock2.waitLock(30000);
  try {
    req = getRequestRecord_(payload.requestId);
    if (req.status !== STATUS.PENDING_APPROVAL) throw new Error('Request is no longer pending approval.');
    req.status = STATUS.APPROVED;
    req.formPdfFileId = finalForm.getId();
    req.lastReason = '';
    req.updatedAt = new Date();
    updateRequestCore_(req);
    updateRequestFiles_(req);
    logAction_(req, approver, 'FINAL_APPROVED', STATUS.PENDING_APPROVAL, STATUS.APPROVED, '');
  } finally { lock2.releaseLock(); }

  notifyFinalApproved_(req, finalForm, DriveApp.getFileById(req.evidencePdfFileId), approver);
  return publicSummary_(req);
}

function getRequestForRevision(requestId) {
  var user = requireRole_(ROLE.REQUESTOR);
  var req = getRequestRecord_(requestId);
  if (req.requesterEmail !== user.email) throw new Error('Access denied.');
  if ([STATUS.REVIEW_REJECTED, STATUS.APPROVAL_REJECTED].indexOf(req.status) === -1) throw new Error('Request is not open for revision.');
  return {
    requestId: req.requestId,
    refNo: req.refNo,
    status: req.status,
    lastReason: req.lastReason,
    items: getCurrentItems_(req.requestId, req.revision).map(function(x){
      return { category:x.category, purpose:x.purpose, paymentDate:x.paymentDate, amount:x.amount };
    })
  };
}

function getRequestDetail(requestId) {
  var user = currentEmployee_();
  var req = getRequestRecord_(requestId);
  authorizeRequest_(user, req);
  return {
    requestId: req.requestId,
    refNo: req.refNo,
    requestDate: dateIso_(req.requestDate),
    requesterEmail: req.requesterEmail,
    employeeName: req.employee.name,
    employee: req.employee,
    total: req.total,
    status: req.status,
    revision: req.revision,
    lastReason: req.lastReason,
    items: getCurrentItems_(req.requestId, req.revision),
    actions: getActions_(req.requestId),
    canRevise: user.role === ROLE.REQUESTOR && req.requesterEmail === user.email && [STATUS.REVIEW_REJECTED, STATUS.APPROVAL_REJECTED].indexOf(req.status) !== -1,
    canReview: user.role === ROLE.REVIEWER && req.status === STATUS.PENDING_REVIEW,
    canApprove: user.role === ROLE.APPROVER && req.status === STATUS.PENDING_APPROVAL
  };
}

function getDocumentBase64(requestId, type) {
  var user = currentEmployee_();
  var req = getRequestRecord_(requestId);
  authorizeRequest_(user, req);
  var id = type === 'evidence' ? req.evidencePdfFileId : req.formPdfFileId;
  if (!id) throw new Error('Document is not ready.');
  var file = DriveApp.getFileById(id);
  var blob = file.getBlob();
  return { fileName:file.getName(), mimeType:blob.getContentType() || MimeType.PDF, base64:Utilities.base64Encode(blob.getBytes()) };
}

function authorizeRequest_(user, req) {
  if (user.role === ROLE.REQUESTOR && req.requesterEmail === user.email) return;
  if (user.role === ROLE.REVIEWER && user.name === CFG.REVIEWER_NAME) return;
  if (user.role === ROLE.APPROVER && user.name === CFG.APPROVER_NAME) return;
  throw new Error('Access denied.');
}

function nextRefNo_(date) {
  var sh = getDataSs_().getSheetByName('Counters');
  var key = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var rows = sh.getDataRange().getValues();
  var row = 0, seq = 0;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === key) { row = i + 1; seq = Number(rows[i][1]) || 0; break; }
  }
  seq++;
  if (!row) sh.appendRow([key, seq]); else sh.getRange(row, 2).setValue(seq);
  var year = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy');
  var md = Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMdd');
  return CFG.REF_PREFIX + '-' + year + '-' + md + '-' + String(seq).padStart(CFG.REF_SEQUENCE_DIGITS, '0');
}

function createRequestFolder_() {
  return getOutputFolder_().createFolder('ERF-' + Utilities.getUuid());
}

function appendNewRequest_(r) {
  getDataSs_().getSheetByName('Requests').appendRow([
    r.requestId,r.refNo,r.requestDate,r.requesterEmail,r.employee.name,r.employee.employeeId,
    r.employee.department,r.employee.location,r.employee.division,r.total,r.status,r.revision,
    r.formPdfFileId,r.evidencePdfFileId,r.requestFolderId,r.lastReason,r.reviewerEmail,r.approverEmail,
    r.createdAt,r.updatedAt
  ]);
}

function appendItems_(requestId, revision, items) {
  var sh = getDataSs_().getSheetByName('RequestItems');
  var values = items.map(function(x, i){
    return [requestId,revision,i+1,x.category,x.purpose,new Date(x.paymentDate + 'T00:00:00'),x.amount,x.evidenceNames.join(' | ')];
  });
  sh.getRange(sh.getLastRow()+1,1,values.length,8).setValues(values);
}

function updateRequestCore_(r) {
  var sh = getDataSs_().getSheetByName('Requests');
  var row = findRequestRow_(sh, r.requestId);
  if (!row) throw new Error('Request record not found.');
  sh.getRange(row,10,1,11).setValues([[
    r.total,r.status,r.revision,r.formPdfFileId || '',r.evidencePdfFileId || '',r.requestFolderId || '',
    r.lastReason || '',r.reviewerEmail || '',r.approverEmail || '',r.createdAt,r.updatedAt
  ]]);
}

function updateRequestFiles_(r) {
  var sh = getDataSs_().getSheetByName('Requests');
  var row = findRequestRow_(sh, r.requestId);
  sh.getRange(row,13,1,3).setValues([[r.formPdfFileId || '',r.evidencePdfFileId || '',r.requestFolderId || '']]);
  sh.getRange(row,20).setValue(new Date());
}

function findRequestRow_(sh, requestId) {
  if (sh.getLastRow() < 2) return 0;
  var ids = sh.getRange(2,1,sh.getLastRow()-1,1).getValues().flat();
  var idx = ids.findIndex(function(x){ return String(x) === String(requestId); });
  return idx < 0 ? 0 : idx + 2;
}

function getAllRequests_() {
  var sh = getDataSs_().getSheetByName('Requests');
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,20).getValues().map(requestFromRow_);
}

function getRequestRecord_(requestId) {
  var list = getAllRequests_();
  var found = list.find(function(r){ return r.requestId === String(requestId); });
  if (!found) throw new Error('Request not found.');
  return found;
}

function requestFromRow_(r) {
  return {
    requestId:String(r[0]), refNo:String(r[1]), requestDate:toDate_(r[2]), requesterEmail:String(r[3]).toLowerCase(),
    employee:{ email:String(r[3]).toLowerCase(), name:String(r[4]), employeeId:String(r[5]), department:String(r[6]), location:String(r[7]), division:String(r[8]) },
    total:Number(r[9]) || 0, status:String(r[10]), revision:Number(r[11]) || 1,
    formPdfFileId:String(r[12] || ''), evidencePdfFileId:String(r[13] || ''), requestFolderId:String(r[14] || ''),
    lastReason:String(r[15] || ''), reviewerEmail:String(r[16] || '').toLowerCase(), approverEmail:String(r[17] || '').toLowerCase(),
    createdAt:toDate_(r[18]), updatedAt:toDate_(r[19])
  };
}

function getCurrentItems_(requestId, revision) {
  var sh = getDataSs_().getSheetByName('RequestItems');
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,8).getValues()
    .filter(function(r){ return String(r[0]) === String(requestId) && Number(r[1]) === Number(revision); })
    .sort(function(a,b){ return Number(a[2]) - Number(b[2]); })
    .map(function(r){
      return { lineNo:Number(r[2]), category:String(r[3]), purpose:String(r[4]), paymentDate:dateIso_(r[5]), amount:Number(r[6]) || 0, evidenceNames:String(r[7] || '').split(' | ').filter(Boolean) };
    });
}

function logAction_(req, actor, action, fromStatus, toStatus, reason) {
  getDataSs_().getSheetByName('Actions').appendRow([
    req.requestId,req.refNo,req.revision,actor.email,actor.name,actor.role,action,fromStatus || '',toStatus || '',reason || '',new Date()
  ]);
}

function getActions_(requestId) {
  var sh = getDataSs_().getSheetByName('Actions');
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2,1,sh.getLastRow()-1,11).getValues()
    .filter(function(r){ return String(r[0]) === String(requestId); })
    .map(function(r){ return { revision:Number(r[2]),actorEmail:String(r[3]),actorName:String(r[4]),actorRole:String(r[5]),action:String(r[6]),fromStatus:String(r[7]),toStatus:String(r[8]),reason:String(r[9]),timestamp:r[10] }; });
}

function publicSummary_(r) {
  return { requestId:r.requestId,refNo:r.refNo,requestDate:dateIso_(r.requestDate),requesterEmail:r.requesterEmail,employeeName:r.employee.name,total:r.total,status:r.status,revision:r.revision,lastReason:r.lastReason || '',updatedAt:r.updatedAt };
}

function sortNewest_(a,b){ return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(); }
function sortOldest_(a,b){ return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); }
function toDate_(v){ return v instanceof Date ? v : new Date(v); }
function dateIso_(v){ return Utilities.formatDate(toDate_(v),Session.getScriptTimeZone(),'yyyy-MM-dd'); }

function generateFormPdf_(req, items, stage) {
  var template = DriveApp.getFileById(CFG.TEMPLATE_SPREADSHEET_ID);
  var folder = DriveApp.getFolderById(req.requestFolderId);
  var temp = template.makeCopy('TMP-' + req.refNo + '-R' + req.revision, folder);
  try {
    var ss = SpreadsheetApp.openById(temp.getId());
    var sh = CFG.TEMPLATE_SHEET_NAME ? ss.getSheetByName(CFG.TEMPLATE_SHEET_NAME) : ss.getSheets()[0];
    if (!sh) throw new Error('Template sheet was not found.');

    sh.getRange('B16:G31').clearContent();
    [CFG.CELLS.requestDate,CFG.CELLS.refNo,CFG.CELLS.employeeName,CFG.CELLS.employeeId,CFG.CELLS.department,CFG.CELLS.location,CFG.CELLS.division,CFG.CELLS.total,CFG.CELLS.preparedBy,CFG.CELLS.reviewedBy,CFG.CELLS.approvedBy].forEach(function(a1){ sh.getRange(a1).clearContent(); });
    try { sh.getImages().forEach(function(img){ if (img.getAnchorCell().getRow() >= 34) img.remove(); }); } catch(e) {}

    sh.getRange(CFG.CELLS.requestDate).setValue(req.requestDate);
    sh.getRange(CFG.CELLS.refNo).setValue(req.refNo);
    sh.getRange(CFG.CELLS.employeeName).setValue(req.employee.name);
    sh.getRange(CFG.CELLS.employeeId).setValue(req.employee.employeeId);
    sh.getRange(CFG.CELLS.department).setValue(req.employee.department);
    sh.getRange(CFG.CELLS.location).setValue(req.employee.location);
    sh.getRange(CFG.CELLS.division).setValue(req.employee.division);
    sh.getRange(CFG.CELLS.total).setValue(req.total);

    var actors = workflowActors_();
    sh.getRange(CFG.CELLS.preparedBy).setValue(req.employee.name);
    sh.getRange(CFG.CELLS.reviewedBy).setValue(actors.reviewer.name);
    sh.getRange(CFG.CELLS.approvedBy).setValue(actors.approver.name);

    items.forEach(function(item, i){
      var row = CFG.ITEM_START_ROW + i;
      sh.getRange(row,2).setValue(item.category);
      sh.getRange(row,5).setValue(item.purpose);
      sh.getRange(row,6).setValue(new Date(item.paymentDate + 'T00:00:00'));
      sh.getRange(row,7).setValue(item.amount);
    });

    insertSignature_(sh, req.requesterEmail, CFG.SIGNATURES.prepared);
    if (stage === 'REVIEWER' || stage === 'APPROVER') insertSignature_(sh, req.reviewerEmail, CFG.SIGNATURES.reviewed);
    if (stage === 'APPROVER') insertSignature_(sh, req.approverEmail, CFG.SIGNATURES.approved);

    SpreadsheetApp.flush();
    var blob = exportSheetPdf_(ss.getId(), sh.getSheetId(), req.refNo + '.pdf');
    var filename = stage === 'APPROVER' ? req.refNo + '.pdf' : req.refNo + '-R' + req.revision + '-' + stage + '.pdf';
    return folder.createFile(blob.setName(filename));
  } finally {
    temp.setTrashed(true);
  }
}

function insertSignature_(sh, employeeEmail, anchor) {
  var emp = employeeByEmail_(employeeEmail);
  assertSignature_(emp);
  var blob = DriveApp.getFileById(emp.signatureFileId).getBlob();
  var image = sh.insertImage(blob, anchor.col, anchor.row, anchor.x, anchor.y);
  image.setWidth(anchor.width).setHeight(anchor.height);
}

function employeeByEmail_(email) {
  var sh = getDataSs_().getSheetByName('Employees');
  var rows = sh.getDataRange().getValues();
  for (var i=1;i<rows.length;i++) {
    if (String(rows[i][0] || '').trim().toLowerCase() === String(email).toLowerCase()) {
      return { email:String(rows[i][0]).toLowerCase(),name:String(rows[i][1]),employeeId:String(rows[i][2]),department:String(rows[i][3]),location:String(rows[i][4]),division:String(rows[i][5]),role:String(rows[i][6]).toUpperCase(),signatureFileId:String(rows[i][7] || '') };
    }
  }
  throw new Error('Employee not found: ' + email);
}

function exportSheetPdf_(spreadsheetId, gid, filename) {
  var params = [
    'format=pdf','size=A4','portrait=true','fitw=true','sheetnames=false','printtitle=false',
    'pagenumbers=false','gridlines=false','fzr=false','top_margin=0.00','bottom_margin=0.35',
    'left_margin=0.20','right_margin=0.20','gid=' + encodeURIComponent(gid)
  ].join('&');
  var url = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/export?' + params;
  var res = UrlFetchApp.fetch(url,{headers:{Authorization:'Bearer ' + ScriptApp.getOAuthToken()},muteHttpExceptions:true});
  if (res.getResponseCode() !== 200) throw new Error('PDF export failed: HTTP ' + res.getResponseCode());
  return res.getBlob().setName(filename);
}

function notifyReviewer_(req, formFile, evidenceFile, isRevision) {
  var reviewer = workflowActors_().reviewer;
  var subject = '[Action Required] ' + (isRevision ? 'Revised ' : '') + 'Expense Request ' + req.refNo;
  var body = emailShell_('Expense Request Pending Review',
    '<p>Dear ' + esc_(reviewer.name) + ',</p><p>' + esc_(req.employee.name) + ' has ' + (isRevision ? 'resubmitted' : 'submitted') + ' an Expense Request requiring your review.</p>' +
    facts_(req) + '<p><a href="' + esc_(ScriptApp.getService().getUrl() || '') + '">Open Expense Approval System</a></p>');
  sendMail_(req,'PENDING_REVIEW',reviewer.email,'',subject,body,[formFile.getBlob(),evidenceFile.getBlob()]);
}

function notifyApprover_(req, formFile, evidenceFile) {
  var approver = workflowActors_().approver;
  var subject = '[Approval Required] Expense Request ' + req.refNo;
  var body = emailShell_('Expense Request Pending Approval',
    '<p>Dear ' + esc_(approver.name) + ',</p><p>An Expense Request has been reviewed and requires your final approval.</p>' +
    facts_(req) + '<p><a href="' + esc_(ScriptApp.getService().getUrl() || '') + '">Open Expense Approval System</a></p>');
  sendMail_(req,'PENDING_APPROVAL',approver.email,'',subject,body,[formFile.getBlob(),evidenceFile.getBlob()]);
}

function notifyRejectedByReviewer_(req, reviewer, reason) {
  var subject = '[Revision Required] Expense Request ' + req.refNo;
  var body = emailShell_('Expense Request Rejected',
    '<p>Dear ' + esc_(req.employee.name) + ',</p><p>Your request requires revision.</p>' + facts_(req) +
    '<p><b>Rejected by:</b> ' + esc_(reviewer.name) + '</p><p><b>Reason:</b><br>' + esc_(reason) + '</p><p>Please revise and resubmit the same reference number.</p>');
  sendMail_(req,'REVIEW_REJECTED',req.requesterEmail,'',subject,body,[]);
}

function notifyRejectedByApprover_(req, approver, reason) {
  var reviewer = workflowActors_().reviewer;
  var subject = '[Revision Required] Expense Request ' + req.refNo;
  var body = emailShell_('Expense Request Rejected by Approver',
    '<p>Dear ' + esc_(req.employee.name) + ',</p><p>Your request was rejected during final approval.</p>' + facts_(req) +
    '<p><b>Rejected by:</b> ' + esc_(approver.name) + '</p><p><b>Reason:</b><br>' + esc_(reason) + '</p><p>After revision the request returns to Reviewer first.</p>');
  sendMail_(req,'APPROVAL_REJECTED',req.requesterEmail,reviewer.email,subject,body,[]);
}

function notifyFinalApproved_(req, formFile, evidenceFile, approver) {
  var reviewer = workflowActors_().reviewer;
  var cc = [reviewer.email, CFG.FINAL_APPROVED_CC].filter(Boolean).join(',');
  var subject = '[Approved] Expense Request ' + req.refNo;
  var body = emailShell_('Expense Request Approved',
    '<p>Dear ' + esc_(req.employee.name) + ',</p><p>Your Expense Request has received final approval.</p>' + facts_(req) +
    '<p><b>Approved by:</b> ' + esc_(approver.name) + '</p><p>The final signed form and evidence PDF are attached.</p>');
  sendMail_(req,'FINAL_APPROVED',req.requesterEmail,cc,subject,body,[formFile.getBlob(),evidenceFile.getBlob()]);
}

function facts_(req) {
  return '<table cellpadding="4" cellspacing="0">' +
    '<tr><td><b>Reference No.</b></td><td>: ' + esc_(req.refNo) + '</td></tr>' +
    '<tr><td><b>Requestor</b></td><td>: ' + esc_(req.employee.name) + '</td></tr>' +
    '<tr><td><b>Request Date</b></td><td>: ' + esc_(Utilities.formatDate(req.requestDate,Session.getScriptTimeZone(),'dd MMMM yyyy')) + '</td></tr>' +
    '<tr><td><b>Total Amount</b></td><td>: IDR ' + Number(req.total).toLocaleString('en-US') + '</td></tr>' +
    '<tr><td><b>Revision</b></td><td>: ' + req.revision + '</td></tr></table>';
}

function emailShell_(title, inner) {
  return '<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.5">' +
    '<div style="border-bottom:4px solid #0b3768;padding-bottom:10px;margin-bottom:18px"><b style="font-size:18px;color:#0b3768">Metrotech Indonesia</b><br><span style="font-size:13px;color:#667085">' + esc_(title) + '</span></div>' +
    inner + '<p style="margin-top:24px;color:#667085;font-size:12px">This is an automated notification from the Metrotech Expense Approval System. Please do not reply to this email.</p></div>';
}

function sendMail_(req,event,to,cc,subject,html,attachments) {
  var status='SENT', error='';
  try {
    MailApp.sendEmail({
      to:to,
      cc:cc || undefined,
      subject:subject,
      body:stripHtml_(html),
      htmlBody:html,
      attachments:attachments || [],
      name:CFG.MAIL_SENDER_NAME,
      noReply:true
    });
  } catch(e) {
    status='FAILED'; error=String(e && e.message ? e.message : e); throw e;
  } finally {
    getDataSs_().getSheetByName('EmailLog').appendRow([req.requestId,req.refNo,event,to,cc || '',new Date(),status,error]);
  }
}

function stripHtml_(html){ return String(html).replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' '); }
function esc_(s){ return String(s == null ? '' : s).replace(/[&<>'"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]; }); }
