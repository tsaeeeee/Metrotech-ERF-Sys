const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=process.argv[2],result=[];
function walk(dir){for(const name of fs.readdirSync(dir).sort()){
  const full=path.join(dir,name),stat=fs.lstatSync(full);
  if(stat.isSymbolicLink())throw new Error('Document symlinks require manual review');
  if(stat.isDirectory())walk(full);
  else if(stat.isFile())result.push([path.relative(root,full),crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
}}
walk(root);process.stdout.write(JSON.stringify(result));
