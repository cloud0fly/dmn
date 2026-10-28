import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs,{mkdtempSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {mock} from 'node:test';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {DmnStore} from '../src/store.ts';
import {createBackup,verifyBackup,restoreBackup} from '../src/backup.ts';
import {acquireMaintenance} from '../src/maintenance.ts';
import {setup} from './fixtures.ts';
import {MemoryManager} from '../src/memory.ts';

test('P5 paired backup refuses active clients; verified original-location restore preserves DB, roots and history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-backup-')),db=join(dir,'queue.sqlite'),bundle=join(dir,'backup');let store:DmnStore|undefined;
 try{
  store=new DmnStore(db);store.run("INSERT INTO model_nodes(node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES('a','p','m','fixed-root','persona','memory:a')");
  mkdirSync(db+'.runtime/a/sessions',{recursive:true});writeFileSync(db+'.runtime/a/sessions/session.v4.jsonl','private history\n');
  await assert.rejects(createBackup(db,bundle),{code:'CONFLICT'});store.close();store=undefined;
  await createBackup(db,bundle);const report=await verifyBackup(bundle);assert.equal(report.schemaVersion,8);assert.equal(report.files,2);
  await assert.rejects(createBackup(db,bundle),{code:'CONFLICT'});
  await assert.rejects(restoreBackup(bundle,join(dir,'other.sqlite')),{code:'FORBIDDEN'});
  await assert.rejects(restoreBackup(bundle,db),{code:'CONFLICT'});
  renameSync(db,db+'.before');renameSync(db+'.runtime',db+'.runtime.before');
  for(const suffix of ['-wal','-shm'])if(existsSync(db+suffix))renameSync(db+suffix,db+'.before'+suffix);
  // No WAL belongs to the closed connection; a stale sidecar must also block restore.
  writeFileSync(db+'-wal','stale');await assert.rejects(restoreBackup(bundle,db),{code:'CONFLICT'});rmSync(db+'-wal');
  await restoreBackup(bundle,db);store=new DmnStore(db);
  assert.equal(store.one<{session_id:string}>('SELECT session_id FROM model_nodes')!.session_id,'fixed-root');
  assert.equal(readFileSync(db+'.runtime/a/sessions/session.v4.jsonl','utf8'),'private history\n');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('P5 paired restore preserves source-linked FTS memory, owner isolation and unprocessed queue',async()=>{
 const f=setup();let restored:DmnStore|undefined;
 try{
  const source=f.a.send({to:'b',topicId:f.topic.id,content:'Durable queue rollback is necessary.'});const manager=new MemoryManager(f.store);
  const saved=manager.bindNode('a').propose({kind:'semantic',content:'Durable queue rollback is necessary.',subjective:false,confidence:.9,importance:.8,sourceMessageIds:[source.messageId]});assert.equal(saved.status,'accepted');
  f.store.close();const bundle=join(dirname(f.path),'backup');await createBackup(f.path,bundle);
  for(const suffix of ['','-wal','-shm'])if(existsSync(f.path+suffix))renameSync(f.path+suffix,f.path+'.before'+suffix);
  await restoreBackup(bundle,f.path);restored=new DmnStore(f.path);const memory=new MemoryManager(restored);
  assert.equal(memory.bindNode('a').search({query:'durable'})[0]?.id,saved.memoryId);assert.equal(memory.bindNode('b').search({query:'durable'}).length,0);
  assert.equal(restored.one<{n:number}>("SELECT count(*) n FROM deliveries WHERE status='queued'")!.n,1);
  assert.equal(restored.one<{n:number}>('SELECT count(*) n FROM model_turns')!.n,0);
 }finally{restored?.close();f.cleanup();}
});

test('P5 interrupted restore remains fenced and does not silently start with half a pair',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-restore-fault-')),db=join(dir,'queue.sqlite'),bundle=join(dir,'backup');
 try{
  const store=new DmnStore(db);store.close();mkdirSync(db+'.runtime/a',{recursive:true});writeFileSync(db+'.runtime/a/log','history');await createBackup(db,bundle);
  for(const suffix of ['','-wal','-shm','.runtime'])if(existsSync(db+suffix))renameSync(db+suffix,db+'.before'+suffix);
  const rename=fs.renameSync;const mocked=mock.method(fs,'renameSync',(...args:Parameters<typeof rename>)=>{if(args[1]===db+'.runtime')throw Error('injected pair commit interruption');return rename(...args);});syncBuiltinESMExports();
  try{await assert.rejects(restoreBackup(bundle,db));}finally{mocked.mock.restore();syncBuiltinESMExports();}
  assert(existsSync(db+'.restore-incomplete'));assert.throws(()=>new DmnStore(db),{code:'CONFLICT'});assert(existsSync(bundle+'/manifest.json'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('P5 SQLite snapshot includes committed WAL after process loss; runtime junctions are refused',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-wal-backup-')),db=join(dir,'queue.sqlite'),bundle=join(dir,'backup');
 try{
  const store=new DmnStore(db);store.close();
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;INSERT INTO model_nodes(node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES('wal-node','p','m','root','persona','memory:wal')");process.exit(23);`,db],{encoding:'utf8'});assert.equal(child.status,23,child.stderr);assert(existsSync(db+'-wal'));
  await createBackup(db,bundle);const snapshot=new DatabaseSync(join(bundle,'database.sqlite'),{readOnly:true});try{assert.equal((snapshot.prepare('SELECT node_id FROM model_nodes').get() as {node_id:string}).node_id,'wal-node');}finally{snapshot.close();}
  mkdirSync(db+'.runtime');const outside=join(dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'private'),'must not copy');symlinkSync(outside,db+'.runtime/link',process.platform==='win32'?'junction':'dir');await assert.rejects(createBackup(db,join(dir,'bad-backup')),{code:'FORBIDDEN'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('P5 backup fails closed on maintenance/Runtime markers, corrupted manifest and path injection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-backup-guard-')),db=join(dir,'queue.sqlite'),bundle=join(dir,'backup');
 try{
  const store=new DmnStore(db);store.close();
  const release=acquireMaintenance(db);assert.throws(()=>new DmnStore(db),{code:'CONFLICT'});release();
  mkdirSync(db+'.runtime/a',{recursive:true});writeFileSync(db+'.runtime/a/runtime.lock','');
  await assert.rejects(createBackup(db,bundle),{code:'CONFLICT'});assert(existsSync(db+'.runtime/a/runtime.lock'));rmSync(db+'.runtime/a/runtime.lock');
  writeFileSync(db+'.runtime/a/log','history');await createBackup(db,bundle);
  writeFileSync(join(bundle,'runtime/a/log'),'tampered');await assert.rejects(verifyBackup(bundle),{code:'STORAGE'});
  writeFileSync(join(bundle,'runtime/a/log'),'history');const p=join(bundle,'manifest.json');const m=JSON.parse(readFileSync(p,'utf8'));
  m.files[0].path='../escape';writeFileSync(p,JSON.stringify(m));await assert.rejects(verifyBackup(bundle),{code:'VALIDATION'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
