import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,lstatSync,readdirSync,readFileSync,mkdirSync,writeFileSync,renameSync,copyFileSync,statSync,realpathSync,unlinkSync,createReadStream,rmdirSync} from 'node:fs';
import {resolve,dirname,join,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './errors.ts';
import {acquireMaintenance,databasePath,requireNoClients} from './maintenance.ts';

const versions=()=>{const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));return{sdk:p.dependencies['@deepseek-ai/dsh-sdk-client'] as string,cordis:p.dependencies['@deepseek-ai/cordis'] as string};};
const safePath=z.string().min(1).max(2048).refine(p=>!/[\\:\0]/.test(p)&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..'));
const manifestSchema=z.strictObject({format:z.literal(1),createdAt:z.iso.datetime(),database:z.string().min(1),schemaVersion:z.number().int().min(1).max(8),platform:z.string(),sdk:z.string(),cordis:z.string(),runtimePresent:z.boolean(),
 files:z.array(z.strictObject({path:safePath,bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(100000)});
type Manifest=z.output<typeof manifestSchema>;
const inside=(parent:string,path:string)=>{const r=relative(parent,path);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r));};
function listFiles(root:string){
 const files:string[]=[];let visited=0;if(!existsSync(root))return files;
 function walk(path:string,depth:number){
  if(depth>32||++visited>100000)fail('STORAGE','Backup file tree exceeds its inspection bound.');
  const s=lstatSync(path);if(s.isSymbolicLink())fail('FORBIDDEN','Backup links are not allowed.');
  if(s.isDirectory()){for(const n of readdirSync(path))walk(join(path,n),depth+1);}
  else if(s.isFile())files.push(path);else fail('FORBIDDEN','Backup accepts only regular files.');
 }
 walk(root,0);return files;
}
async function digest(file:string){
 // SDK inspection is bounded to 16 MiB logs; backup accepts larger files without buffering all data.
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');
}
function checkDatabase(path:string,expected?:number,stopped=false){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const v=(db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(v<1||v>8||(expected!==undefined&&expected!==v))fail('STORAGE','Unsupported or mismatched backup schema.');
  const required=['model_nodes','topics','messages','model_turns',...(v>=7?['user_replies']:[]),...(v>=8?['node_prompts','node_prompt_requests']:[])];
  for(const name of required)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))fail('STORAGE','Backup does not contain the expected DMN schema.');
  if((db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail('STORAGE','Backup database integrity failed.');
  if(stopped&&(db.prepare("SELECT count(*) n FROM model_turns WHERE status='running'").get() as {n:number}).n)fail('STORAGE','Backup contains an unquiesced running activity.');
  return v;
 }finally{db.close();}
}
export async function verifyBackup(bundle:string){
 const root=resolve(bundle);if(!existsSync(root)||lstatSync(root).isSymbolicLink())fail('FORBIDDEN','A regular backup directory is required.');
 const manifestPath=join(root,'manifest.json');if(!existsSync(manifestPath)||lstatSync(manifestPath).isSymbolicLink()||statSync(manifestPath).size>32*1024*1024)fail('VALIDATION','A complete bounded manifest is required.');
 let raw:unknown;try{raw=JSON.parse(readFileSync(manifestPath,'utf8'));}catch{fail('VALIDATION','Invalid backup manifest.');}
 const parsed=manifestSchema.safeParse(raw);if(!parsed.success)fail('VALIDATION','Invalid backup manifest.');const m=parsed.data;
 if(!isAbsolute(m.database)||m.platform!==process.platform||m.sdk!==versions().sdk||m.cordis!==versions().cordis)fail('STORAGE','Backup runtime compatibility check failed.');
 const expected=new Set(m.files.map(f=>f.path));if(expected.size!==m.files.length||!expected.has('database.sqlite'))fail('VALIDATION','Invalid or duplicated backup file set.');
 const actual=listFiles(root).map(p=>relative(root,p).split(sep).join('/')).filter(p=>p!=='manifest.json');
 if(actual.length!==expected.size||actual.some(p=>!expected.has(p))||actual.some(p=>p!=='database.sqlite'&&!p.startsWith('runtime/')))fail('STORAGE','Backup file set does not match manifest.');
 if(!m.runtimePresent&&actual.some(p=>p.startsWith('runtime/')))fail('VALIDATION','Unexpected runtime files.');
 for(const f of m.files){const file=join(root,f.path);if(statSync(file).size!==f.bytes||await digest(file)!==f.sha256)fail('STORAGE','Backup file integrity check failed.');}
 checkDatabase(join(root,'database.sqlite'),m.schemaVersion,true);
 return{schemaVersion:m.schemaVersion,files:m.files.length,database:m.database,manifest:m};
}
export async function createBackup(database:string,destination:string){
 const source=databasePath(database),target=resolve(destination);
 if(!existsSync(source))fail('NOT_FOUND','Database does not exist.');
 if(existsSync(target))fail('CONFLICT','Backup destination already exists.');
 mkdirSync(dirname(target),{recursive:true});const targetReal=join(realpathSync(dirname(target)),target.split(sep).at(-1)!);
 if(inside(source+'.runtime',targetReal)||inside(targetReal,source))fail('FORBIDDEN','Backup cannot contain its source or be inside Runtime Home.');
 const release=acquireMaintenance(source);
 try{
  requireNoClients(source);if(existsSync(source+'.restore-incomplete'))fail('CONFLICT','Incomplete restore blocks backup.');
  const runtime=source+'.runtime',runtimeFiles=listFiles(runtime);
  if(runtimeFiles.some(p=>p.endsWith(sep+'runtime.lock')))fail('CONFLICT','Runtime markers require manual reconciliation before backup.');
  const db=new DatabaseSync(source,{readOnly:true});const partial=targetReal+'.partial-'+randomUUID();
  try{
   const version=checkDatabase(source);
   if((db.prepare("SELECT count(*) n FROM model_turns WHERE status='running'").get() as {n:number}).n)fail('CONFLICT','Running turns require quarantine and reconciliation before backup.');
   mkdirSync(partial);await backup(db,join(partial,'database.sqlite'));
   // A self-contained artifact must not generate unmanifested WAL/SHM on verification.
   const snapshot=new DatabaseSync(join(partial,'database.sqlite'));try{snapshot.exec('PRAGMA journal_mode=DELETE;');}finally{snapshot.close();}
   if(existsSync(runtime))mkdirSync(join(partial,'runtime'));
   for(const file of runtimeFiles){const dest=join(partial,'runtime',relative(runtime,file));mkdirSync(dirname(dest),{recursive:true});copyFileSync(file,dest);}
   const files=[];for(const file of listFiles(partial))files.push({path:relative(partial,file).split(sep).join('/'),bytes:statSync(file).size,sha256:await digest(file)});
   const manifest:Manifest={format:1,createdAt:new Date().toISOString(),database:source,schemaVersion:version,platform:process.platform,...versions(),runtimePresent:existsSync(runtime),files};
   writeFileSync(join(partial,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});await verifyBackup(partial);
   if(existsSync(targetReal))fail('CONFLICT','Backup destination appeared during creation.');renameSync(partial,targetReal);
   return{created:true,destination:targetReal,schemaVersion:version,files:files.length};
  }finally{db.close();}
 }finally{release();}
}
export async function restoreBackup(bundle:string,database:string,options:{preserveExisting?:boolean}={}){
 const verified=await verifyBackup(bundle),target=databasePath(database),root=resolve(bundle);
 if(target!==verified.database)fail('FORBIDDEN','SDK history requires restoration to the original absolute database location.');
 const release=acquireMaintenance(target);
 try{
  requireNoClients(target);
  const prior=[target,target+'-wal',target+'-shm',target+'.runtime'].filter(existsSync);
  if(existsSync(target+'.restore-incomplete'))fail('CONFLICT','An incomplete restore requires manual inspection.');
  if(prior.length&&!options.preserveExisting)fail('CONFLICT','Restore requires an empty original database and Runtime location.');
  if(prior.length){if(!existsSync(target))fail('CONFLICT','An incomplete previous pair requires manual inspection.');checkDatabase(target,undefined,true);if(listFiles(target+'.runtime').some(p=>p.endsWith(sep+'runtime.lock')))fail('CONFLICT','Busy Runtime blocks replacement restore.');}
  let previousPair:string|undefined;
  const staging=target+'.restore-partial-'+randomUUID();mkdirSync(staging);
  for(const f of verified.manifest.files){const destination=join(staging,f.path);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(root,f.path),destination);if(await digest(destination)!==f.sha256)fail('STORAGE','Restore staging integrity check failed.');}
  if(verified.manifest.runtimePresent&&!existsSync(join(staging,'runtime')))mkdirSync(join(staging,'runtime'));
  checkDatabase(join(staging,'database.sqlite'),verified.schemaVersion,true);
  writeFileSync(target+'.restore-incomplete','Inspect paired database/Runtime restore before starting DMN.',{flag:'wx'});
  if(prior.length){previousPair=target+'.restore-previous-'+randomUUID();mkdirSync(previousPair);for(const old of prior)renameSync(old,join(previousPair,old.slice(target.length)||'database.sqlite'));}
  renameSync(join(staging,'database.sqlite'),target);
  if(verified.manifest.runtimePresent)renameSync(join(staging,'runtime'),target+'.runtime');
  unlinkSync(target+'.restore-incomplete');rmdirSync(staging);
  return{restored:true,database:target,schemaVersion:verified.schemaVersion,inferenceStarted:false,previousPairPreserved:!!previousPair,...(previousPair?{previousPair}: {})};
 }finally{release();/* An incomplete marker deliberately survives a partial commit. */}
}
