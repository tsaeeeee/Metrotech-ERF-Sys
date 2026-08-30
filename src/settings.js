import { pool } from './db.js';

const MASTER_KEY=String(process.env.APP_CONFIG_MASTER_KEY || 'metrotech-erf-dev-config-key-change-me');

const defaults={
  app_base_url:'',
  timezone:'Asia/Jakarta',
  local_login_enabled:'true',
  google_enabled:'false',
  allowed_google_domain:'metrotech.id',
  google_client_id:'',
  google_callback_url:'',
  smtp_enabled:'false',
  smtp_host:'',
  smtp_port:'587',
  smtp_secure:'false',
  smtp_user:'',
  mail_sender_name:'Metrotech Expense Approval System',
  mail_from:'no-reply@metrotech.id',
  mail_override_to:'',
  session_hours:'8',
  cookie_secure:'false',
  login_rate_limit:'10'
};

const secretKeys=new Set(['google_client_secret','smtp_pass','session_secret']);
const publicKeys=new Set([...Object.keys(defaults),...secretKeys]);

function bool(v){
  return String(v).toLowerCase()==='true';
}
function int(v,fallback){
  const n=Number(v);
  return Number.isFinite(n)?Math.round(n):fallback;
}

export async function ensureAppSettings(){
  await pool.query(`
    create table if not exists app_settings(
      key text primary key,
      value text not null default '',
      is_secret boolean not null default false,
      updated_at timestamptz not null default now(),
      updated_by text
    )
  `);

  for(const [key,value] of Object.entries(defaults)){
    await pool.query(
      `insert into app_settings(key,value,is_secret)
       values($1,$2,false)
       on conflict(key) do nothing`,
      [key,value]
    );
  }

  const {rows}=await pool.query(
    `select key from app_settings where key='session_secret' limit 1`
  );
  if(!rows[0]){
    await pool.query(
      `insert into app_settings(key,value,is_secret)
       values(
         'session_secret',
         encode(pgp_sym_encrypt(encode(gen_random_bytes(48),'hex'),$1),'base64'),
         true
       )`,
      [MASTER_KEY]
    );
  }
}

export async function getRuntimeAppSettings(){
  await ensureAppSettings();
  const {rows}=await pool.query(
    `select key,
       case when is_secret
         then pgp_sym_decrypt(decode(value,'base64'),$1)
         else value
       end as value
     from app_settings`,
    [MASTER_KEY]
  );
  const raw={...defaults};
  for(const row of rows) raw[row.key]=row.value;

  const baseUrl=String(raw.app_base_url||'').replace(/\/$/,'');
  return {
    appBaseUrl:baseUrl,
    timezone:String(raw.timezone||'Asia/Jakarta'),
    localLoginEnabled:bool(raw.local_login_enabled),
    googleEnabled:bool(raw.google_enabled),
    allowedGoogleDomain:String(raw.allowed_google_domain||'').toLowerCase().trim(),
    googleClientId:String(raw.google_client_id||'').trim(),
    googleClientSecret:String(raw.google_client_secret||''),
    googleCallbackUrl:String(raw.google_callback_url||'').trim() || (baseUrl?`${baseUrl}/auth/google/callback`:''),
    smtpEnabled:bool(raw.smtp_enabled),
    smtpHost:String(raw.smtp_host||'').trim(),
    smtpPort:int(raw.smtp_port,587),
    smtpSecure:bool(raw.smtp_secure),
    smtpUser:String(raw.smtp_user||'').trim(),
    smtpPass:String(raw.smtp_pass||''),
    mailSenderName:String(raw.mail_sender_name||'Metrotech Expense Approval System').trim(),
    mailFrom:String(raw.mail_from||'').trim(),
    mailOverrideTo:String(raw.mail_override_to||'').trim(),
    sessionHours:Math.min(168,Math.max(1,int(raw.session_hours,8))),
    cookieSecure:bool(raw.cookie_secure),
    loginRateLimit:Math.min(100,Math.max(1,int(raw.login_rate_limit,10))),
    sessionSecret:String(raw.session_secret||'')
  };
}

export async function getPublicAppSettings(){
  await ensureAppSettings();
  const runtime=await getRuntimeAppSettings();
  const {rows}=await pool.query(
    `select key,(coalesce(value,'')<>'') as configured
     from app_settings
     where is_secret=true`
  );
  const flags=Object.fromEntries(rows.map(r=>[r.key,Boolean(r.configured)]));
  return {
    appBaseUrl:runtime.appBaseUrl,
    timezone:runtime.timezone,
    localLoginEnabled:runtime.localLoginEnabled,
    googleEnabled:runtime.googleEnabled,
    allowedGoogleDomain:runtime.allowedGoogleDomain,
    googleClientId:runtime.googleClientId,
    googleCallbackUrl:runtime.googleCallbackUrl,
    googleClientSecretConfigured:Boolean(flags.google_client_secret),
    smtpEnabled:runtime.smtpEnabled,
    smtpHost:runtime.smtpHost,
    smtpPort:runtime.smtpPort,
    smtpSecure:runtime.smtpSecure,
    smtpUser:runtime.smtpUser,
    smtpPasswordConfigured:Boolean(flags.smtp_pass),
    mailSenderName:runtime.mailSenderName,
    mailFrom:runtime.mailFrom,
    mailOverrideTo:runtime.mailOverrideTo,
    sessionHours:runtime.sessionHours,
    cookieSecure:runtime.cookieSecure,
    loginRateLimit:runtime.loginRateLimit,
    sessionSecretConfigured:Boolean(flags.session_secret),
    masterKeyExternal:Boolean(process.env.APP_CONFIG_MASTER_KEY)
  };
}

function validateInput(input){
  const clean={};

  if(input.appBaseUrl!==undefined){
    const value=String(input.appBaseUrl||'').trim().replace(/\/$/,'');
    if(value && !/^https?:\/\//i.test(value))
      throw Object.assign(new Error('App Base URL must start with http:// or https://.'),{status:400});
    clean.app_base_url=value;
  }

  if(input.timezone!==undefined) clean.timezone=String(input.timezone||'Asia/Jakarta').trim();
  if(input.localLoginEnabled!==undefined) clean.local_login_enabled=String(Boolean(input.localLoginEnabled));
  if(input.googleEnabled!==undefined) clean.google_enabled=String(Boolean(input.googleEnabled));
  if(input.allowedGoogleDomain!==undefined)
    clean.allowed_google_domain=String(input.allowedGoogleDomain||'').trim().toLowerCase().replace(/^@/,'');
  if(input.googleClientId!==undefined) clean.google_client_id=String(input.googleClientId||'').trim();
  if(input.googleCallbackUrl!==undefined) clean.google_callback_url=String(input.googleCallbackUrl||'').trim();

  if(input.smtpEnabled!==undefined) clean.smtp_enabled=String(Boolean(input.smtpEnabled));
  if(input.smtpHost!==undefined) clean.smtp_host=String(input.smtpHost||'').trim();
  if(input.smtpPort!==undefined){
    const port=Number(input.smtpPort);
    if(!Number.isInteger(port)||port<1||port>65535)
      throw Object.assign(new Error('SMTP port must be between 1 and 65535.'),{status:400});
    clean.smtp_port=String(port);
  }
  if(input.smtpSecure!==undefined) clean.smtp_secure=String(Boolean(input.smtpSecure));
  if(input.smtpUser!==undefined) clean.smtp_user=String(input.smtpUser||'').trim();
  if(input.mailSenderName!==undefined) clean.mail_sender_name=String(input.mailSenderName||'').trim();
  if(input.mailFrom!==undefined) clean.mail_from=String(input.mailFrom||'').trim().toLowerCase();
  if(input.mailOverrideTo!==undefined) clean.mail_override_to=String(input.mailOverrideTo||'').trim().toLowerCase();

  if(input.sessionHours!==undefined){
    const hours=Number(input.sessionHours);
    if(!Number.isInteger(hours)||hours<1||hours>168)
      throw Object.assign(new Error('Session lifetime must be between 1 and 168 hours.'),{status:400});
    clean.session_hours=String(hours);
  }
  if(input.cookieSecure!==undefined) clean.cookie_secure=String(Boolean(input.cookieSecure));
  if(input.loginRateLimit!==undefined){
    const limit=Number(input.loginRateLimit);
    if(!Number.isInteger(limit)||limit<1||limit>100)
      throw Object.assign(new Error('Login rate limit must be between 1 and 100.'),{status:400});
    clean.login_rate_limit=String(limit);
  }

  return clean;
}

export async function saveAppSettings(input,actorEmail=''){
  await ensureAppSettings();
  const current=await getRuntimeAppSettings();
  const clean=validateInput(input||{});

  const nextLocal=input.localLoginEnabled===undefined
    ? current.localLoginEnabled
    : Boolean(input.localLoginEnabled);
  const nextGoogle=input.googleEnabled===undefined
    ? current.googleEnabled
    : Boolean(input.googleEnabled);
  const nextClientId=input.googleClientId===undefined
    ? current.googleClientId
    : String(input.googleClientId||'').trim();
  const nextClientSecret=String(input.googleClientSecret||'') || current.googleClientSecret;
  const nextBaseUrl=input.appBaseUrl===undefined
    ? current.appBaseUrl
    : String(input.appBaseUrl||'').trim().replace(/\/$/,'');
  const nextCallback=input.googleCallbackUrl===undefined
    ? current.googleCallbackUrl
    : String(input.googleCallbackUrl||'').trim();
  const effectiveCallback=nextCallback || (nextBaseUrl?`${nextBaseUrl}/auth/google/callback`:'');
  const nextGoogleReady=Boolean(nextGoogle && nextClientId && nextClientSecret && effectiveCallback);

  if(!nextLocal && !nextGoogleReady)
    throw Object.assign(
      new Error('Local Login cannot be disabled until Google Workspace authentication is fully configured.'),
      {status:409}
    );

  const client=await pool.connect();
  try{
    await client.query('begin');
    for(const [key,value] of Object.entries(clean)){
      if(!publicKeys.has(key) && !Object.prototype.hasOwnProperty.call(defaults,key)) continue;
      await client.query(
        `insert into app_settings(key,value,is_secret,updated_at,updated_by)
         values($1,$2,false,now(),$3)
         on conflict(key) do update
         set value=excluded.value,is_secret=false,updated_at=now(),updated_by=excluded.updated_by`,
        [key,value,actorEmail]
      );
    }

    const secrets={
      google_client_secret:String(input.googleClientSecret||''),
      smtp_pass:String(input.smtpPassword||'')
    };
    for(const [key,value] of Object.entries(secrets)){
      if(!value) continue;
      await client.query(
        `insert into app_settings(key,value,is_secret,updated_at,updated_by)
         values($1,encode(pgp_sym_encrypt($2,$3),'base64'),true,now(),$4)
         on conflict(key) do update
         set value=excluded.value,is_secret=true,updated_at=now(),updated_by=excluded.updated_by`,
        [key,value,MASTER_KEY,actorEmail]
      );
    }
    await client.query('commit');
  }catch(e){
    await client.query('rollback');
    throw e;
  }finally{
    client.release();
  }
  return getPublicAppSettings();
}

export async function rotateSessionSecret(actorEmail=''){
  await ensureAppSettings();
  await pool.query(
    `insert into app_settings(key,value,is_secret,updated_at,updated_by)
     values(
       'session_secret',
       encode(pgp_sym_encrypt(encode(gen_random_bytes(48),'hex'),$1),'base64'),
       true,now(),$2
     )
     on conflict(key) do update
     set value=excluded.value,is_secret=true,updated_at=now(),updated_by=excluded.updated_by`,
    [MASTER_KEY,actorEmail]
  );
}

export async function getAppReadiness(){
  const settings=await getRuntimeAppSettings();
  const {rows}=await pool.query(`
    select
      count(*) filter(where role='REVIEWER' and active=true)::int as reviewers,
      count(*) filter(where role='APPROVER' and active=true)::int as approvers
    from employees
  `);
  const counts=rows[0]||{reviewers:0,approvers:0};
  const googleReady=!settings.googleEnabled || Boolean(
    settings.allowedGoogleDomain &&
    settings.googleClientId &&
    settings.googleClientSecret &&
    settings.googleCallbackUrl
  );
  const smtpReady=!settings.smtpEnabled || Boolean(settings.smtpHost && settings.mailFrom);
  const httpsReady=!settings.appBaseUrl || settings.appBaseUrl.startsWith('https://');

  return {
    database:true,
    reviewer:Number(counts.reviewers)>0,
    approver:Number(counts.approvers)===1,
    smtp:smtpReady,
    authentication:settings.localLoginEnabled || (settings.googleEnabled && googleReady),
    https:httpsReady,
    sessionSecret:Boolean(settings.sessionSecret),
    masterKeyExternal:Boolean(process.env.APP_CONFIG_MASTER_KEY),
    reviewerCount:Number(counts.reviewers),
    approverCount:Number(counts.approvers)
  };
}
