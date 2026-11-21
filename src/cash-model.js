import {createHash} from 'node:crypto';

export const CASH_CATEGORIES=['Cash Deposit','Akamai Expenses - Maintenance','Akamai Expenses - Deployment','Warehouse Expenses','Bank Action','Team Growth & Expenses','Helper Fee','Tools','Other','Travel Expense','Office Supplies & Expenses','Software & Subscription'];
export const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
// PostgreSQL JSONB can reorder object keys. Hash a canonical representation so
// an uploaded preview, stored snapshot and retry all identify the same batch.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function amount(value,{legacy=false}={}){
  if(legacy&&(value==null||value===''||value==='-'))return '0.00';
  if(legacy&&typeof value==='number'){
    if(!Number.isFinite(value)||Math.abs(value*100-Math.round(value*100))>0.0001)fail('Invalid legacy amount.');
    value=value.toFixed(2);
  }
  const s=String(value??'').trim();
  if(!/^\d{1,13}(\.\d{1,2})?$/.test(s))fail('Enter a non-negative amount with at most two decimals.');
  const [a,b='']=s.split('.');return `${BigInt(a)}.${b.padEnd(2,'0')}`;
}
export const cents=value=>BigInt(String(value).replace('.',''));
export const money=value=>`${value<0n?'-':''}${(value<0n?-value:value)/100n}.${String((value<0n?-value:value)%100n).padStart(2,'0')}`;
export function day(value){
  const s=String(value||'');
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)fail('Enter a valid transaction date.');
  return s;
}
export function text(value,max=4000){const s=String(value??'').trim();if(s.length>max)fail('Text is too long.');return s;}
export function entryInput(value){
  const entry={entry_date:day(value.entry_date),category:text(value.category,120),activity:text(value.activity),notes:text(value.notes),income:amount(value.income||'0'),outcome:amount(value.outcome||'0')};
  if(!entry.category||!entry.activity)fail('Category and activity are required.');
  if((cents(entry.income)>0n)===(cents(entry.outcome)>0n))fail('Choose either income or outcome for a new entry.');
  return entry;
}

// Raw snapshot is retained alongside the normalized records. Identical rows are
// intentionally distinct; checksum prevents re-running the same import batch.
export function inspectSnapshot(snapshot){
  if(snapshot?.format!=='ems-cash-snapshot-v1'||!/^[-\w]{20,150}$/.test(snapshot.spreadsheetId)||!Array.isArray(snapshot.sheets)||snapshot.sheets.length>50)fail('Choose a valid EMS cash snapshot JSON.');
  const sheets=[],warnings=[],ids=new Set();let count=0;
  for(const sheet of snapshot.sheets){
    const source=String(sheet.sheetId),title=text(sheet.title,100);
    if(ids.has(source)||!/^\d+$/.test(source)||!Array.isArray(sheet.rows))fail('Invalid or duplicate sheet.');ids.add(source);
    if(sheet.rows.length>20000)fail('Snapshot sheet is too large.');
    const nonempty=sheet.rows.filter(r=>Array.isArray(r.values)&&r.values.some(v=>v!=null&&v!==''));
    if(!nonempty.length){sheets.push({sheetId:source,title,entries:[],income:'0.00',outcome:'0.00',balance:'0.00'});continue;}
    const header=nonempty.find(r=>r.row===1)?.values?.slice(0,5).map(v=>String(v).trim().toUpperCase());
    if(!/^20\d{2}$/.test(title)||JSON.stringify(header)!==JSON.stringify(['DATE','CATEGORY','ACTIVITY','INCOME','OUTCOME']))fail(`Unrecognized data in ${title}. No sheet will be silently skipped.`);
    let income=0n,outcome=0n;const entries=[],rowIds=new Set(),identical=new Map();
    for(const row of nonempty.filter(r=>r.row>1&&r.values.slice(0,5).some(v=>v!=null&&v!==''))){
      if(!Number.isSafeInteger(row.row)||row.row<2||rowIds.has(row.row))fail(`Invalid row in ${title}.`);rowIds.add(row.row);
      const [date,category,activity,inValue,outValue]=row.values;
      const entry_date=typeof date==='number'&&Number.isInteger(date)?day(new Date(Date.UTC(1899,11,30)+date*86400000).toISOString().slice(0,10)):day(date);
      if(entry_date.slice(0,4)!==title)fail(`Date outside year in ${title} row ${row.row}.`);
      const entry={source_row:row.row,entry_date,category:text(category,120),activity:text(activity),notes:text(row.notes,8000),income:amount(inValue,{legacy:true}),outcome:amount(outValue,{legacy:true}),kind:/^carryover\b/i.test(String(activity||'').trim())?'OPENING':'TRANSACTION'};
      if(!entry.category||cents(entry.income)+cents(entry.outcome)===0n)fail(`Incomplete monetary row: ${title} row ${row.row}.`);
      if(entry.kind==='OPENING'&&(cents(entry.outcome)>0n||cents(entry.income)===0n))fail('Review the carryover row before importing.');
      if(!entry.activity)warnings.push(`${title} row ${row.row}: activity is blank; preserved.`);
      if(cents(entry.income)>0n&&cents(entry.outcome)>0n)warnings.push(`${title} row ${row.row}: both income and outcome are preserved.`);
      const key=JSON.stringify([entry_date,entry.category,entry.activity,entry.income,entry.outcome]);
      if(identical.has(key))warnings.push(`${title} rows ${identical.get(key)} and ${row.row}: identical values; both preserved.`);else identical.set(key,row.row);
      entries.push(entry);income+=cents(entry.income);outcome+=cents(entry.outcome);
    }
    if(title==='2026'&&!entries.some(e=>e.kind==='OPENING'))warnings.push('2026 has no carryover. Its balance is kept separate from previous books.');
    const headerBalance=nonempty.find(r=>r.row===1)?.values?.[7];
    if(typeof headerBalance==='number'&&cents(amount(headerBalance,{legacy:true}))!==income-outcome)fail(`${title}: top balance does not match its transactions. Review the snapshot.`);
    for(const row of nonempty){
      if(String(row.values[6]||'').trim().toLowerCase()==='current balance'&&typeof row.values[7]==='number'&&cents(amount(row.values[7],{legacy:true}))!==income-outcome)
        warnings.push(`${title} row ${row.row}: summary balance differs from transactions; calculated balance is ${money(income-outcome)}.`);
    }
    count+=entries.length;sheets.push({sheetId:source,title,entries,income:money(income),outcome:money(outcome),balance:money(income-outcome)});
  }
  if(!count||count>50000)fail('Snapshot must contain between 1 and 50,000 transaction rows.');
  return {checksum:digest(snapshot),source:snapshot.spreadsheetId,capturedAt:snapshot.capturedAt,count,warnings,sheets};
}
