import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {snapshot} from './upgrade-ems.js';

const [mode,target,extra]=process.argv.slice(2);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=(file,data)=>fs.writeFile(file,JSON.stringify(data,null,2)+'\n',{mode:0o600});
const envMap=values=>Object.fromEntries(values.map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)]}));
const sorted=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
const mounts=container=>container.Mounts.map(m=>[m.Destination,m.Type,m.Source,m.RW]).sort();
async function files(roots){
  const values=[];
  async function walk(root,dir,label){
    for(const name of (await fs.readdir(dir)).sort()){
      const file=path.join(dir,name),stat=await fs.lstat(file);
      assert(!stat.isSymbolicLink(),'Document symlinks require manual review');
      if(stat.isDirectory())await walk(root,file,label);
      else if(stat.isFile())values.push([`${label}/${path.relative(root,file)}`,crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
    }
  }
  for(const [label,root] of Object.entries(roots))await walk(root,root,label);
  return values.sort((a,b)=>a[0].localeCompare(b[0]));
}
if(mode==='prepare'){
  const [app]=await read('/release/app-before.json');
  const [db]=await read('/release/db-before.json');
  assert.equal(app.Name,'/metrotech-erf-app');assert.equal(db.Name,'/metrotech-erf-db');
  assert.equal(app.Config.Labels['com.docker.compose.project.working_dir'],'/srv/metrotech/erf');
  assert.equal(Object.keys(app.HostConfig.PortBindings||{}).length,0,'Unexpected public app ports');
  assert.deepEqual(Object.keys(app.NetworkSettings.Networks).sort(),['metrotech_erf_internal','metrotech_proxy']);
  assert.equal(app.Mounts.length,2,'Additional mounts require review');
  assert(app.Mounts.some(m=>m.Destination==='/data/pdfs'&&m.Type==='volume'&&m.Name==='metrotech_erf_pdfs'&&m.RW));
  assert(app.Mounts.some(m=>m.Destination==='/data/signatures'&&m.Type==='bind'&&m.Source==='/srv/metrotech/erf/signatures'&&!m.RW));
  const env=envMap(app.Config.Env),dbEnv=envMap(db.Config.Env);
  assert.equal(env.POSTGRES_DB||'metrotech_erf',dbEnv.POSTGRES_DB);
  assert.equal(env.POSTGRES_USER||'metrotech_erf',dbEnv.POSTGRES_USER);
  assert(env.POSTGRES_PASSWORD===dbEnv.POSTGRES_PASSWORD,'App/DB credentials differ; manual review required');
  assert.equal(env.PDF_DIR||'/data/pdfs','/data/pdfs');
  assert.equal(env.SIGNATURE_DIR||'/data/signatures','/data/signatures');
  assert(!env.PROFILE_SIGNATURE_DIR||env.PROFILE_SIGNATURE_DIR.startsWith('/data/pdfs/'));
  assert(!app.Config.Env.some(v=>/[\r\n]/.test(v)),'Multiline environment needs review');
  assert(!db.Config.Env.some(v=>/[\r\n]/.test(v)));
  await fs.writeFile('/release/runtime.env',app.Config.Env.join('\n')+'\n',{mode:0o600});
  await fs.writeFile('/release/db.env',db.Config.Env.join('\n')+'\n',{mode:0o600});
  // Compose interpolates dollars; double each one in saved runtime values.
  const environment=Object.fromEntries(Object.entries(env).map(([key,value])=>[key,value.replaceAll('$',()=> '$$')]));
  for(const [name,image] of [['candidate',target],['rollback',app.Image]])
    await save(`/release/${name}.compose.json`,{services:{app:{image,environment}}});
  const endpoint=app.NetworkSettings.Networks.metrotech_proxy;
  assert(endpoint.IPAddress,'Missing production proxy address');
  assert((endpoint.Aliases||[]).every(alias=>['metrotech-erf-app','app'].includes(alias)||/^[0-9a-f]{12,64}$/.test(alias)),
    'Custom proxy aliases require review before cutover');
  await fs.writeFile('/release/proxy-ip',endpoint.IPAddress+'\n');
  await save('/release/proxy-aliases.json',endpoint.Aliases||[]);
  console.log(JSON.stringify({runtimePreserved:true,pdfMode:env.PDF_MODE||'mock',
    mailGatewayConfigured:Boolean(env.MAIL_GATEWAY_URL&&env.MAIL_GATEWAY_SECRET)}));
}else if(mode==='config'){
  const [old]=await read('/release/app-before.json'),config=await read(target);
  assert(sorted(config.services.app.environment)===sorted(envMap(old.Config.Env)),
    'Compose would change runtime environment; review configuration before maintenance');
  console.log('COMPOSE_RUNTIME_VERIFIED');
}else if(mode==='container'){
  const [old]=await read('/release/app-before.json'),[current]=await read(target);
  assert(sorted(envMap(current.Config.Env))===sorted(envMap(old.Config.Env)),'Runtime environment changed');
  assert.deepEqual(mounts(current),mounts(old),'Production mounts changed');
  assert.equal(current.Image,extra,'Unexpected application image');
  console.log('RUNTIME_AND_MOUNTS_VERIFIED');
}else if(['files','check-files','check-backup-files'].includes(mode)){
  const roots=mode==='check-backup-files'?{pdfs:'/release/pdfs',signatures:'/release/signatures'}:
    {pdfs:'/data/pdfs',signatures:'/data/signatures'};
  const result=await files(roots);
  if(mode==='files')await save(target,result);
  else assert.deepEqual(result,await read(target),'Document bytes changed');
  console.log(`DOCUMENTS_VERIFIED: ${result.length} files`);
}else if(mode==='restore-pdfs'){
  assert.deepEqual(await files({pdfs:'/release/pdfs',signatures:'/release/signatures'}),await read('/release/files-before.json'));
  // Used only with app stopped and a verified matching frozen backup.
  for(const name of await fs.readdir('/data/pdfs'))await fs.rm(path.join('/data/pdfs',name),{recursive:true,force:true});
  await fs.cp('/release/pdfs','/data/pdfs',{recursive:true,force:true});
  console.log('PDF_BACKUP_RESTORED');
}else if(['capture','check','capture-all','check-all'].includes(mode)){
  const client=new pg.Client({host:process.env.POSTGRES_HOST||'db',port:Number(process.env.POSTGRES_PORT||5432),
    database:process.env.POSTGRES_DB||'metrotech_erf',user:process.env.POSTGRES_USER||'metrotech_erf',password:process.env.POSTGRES_PASSWORD});
  try{
    await client.connect();let result=await snapshot(client);
    if(mode.endsWith('-all')){
      result={};
      const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'session' ORDER BY tablename")).rows;
      for(const {tablename} of tables){
        const identifier='"'+tablename.replaceAll('"','""')+'"';
        result[tablename]=(await client.query(`SELECT count(*)::text AS count,
          md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS digest FROM ${identifier} t`)).rows[0];
      }
      result.sequences=(await client.query("SELECT sequencename,last_value::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
    }
    if(mode.startsWith('capture'))await save(target,result);
    else assert.deepEqual(result,await read(target),'Stored data changed since snapshot');
    console.log('DATABASE_CONTENTS_VERIFIED');
  }finally{await client.end()}
}else throw new Error('Unknown cutover verification mode');
