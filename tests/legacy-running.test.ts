import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBackup,verifyBackup,restoreBackup} from '../src/backup.ts';
import {DmnStore} from '../src/store.ts';
import {DmnGateway} from '../src/gateway.ts';
import {TopicRunner} from '../src/runner.ts';

function legacy(path:string,version:number,status='running'){
 const db=new DatabaseSync(path);
 const files=['001_init.sql','002_node_capabilities.sql','003_runtime.sql','004_memory.sql','005_policy_recovery.sql','006_desktop_operator.sql','007_user_replies.sql'];
 for(const file of files.slice(0,version))db.exec(readFileSync(new URL('../sql/'+file,import.meta.url),'utf8'));
 db.exec(`PRAGMA user_version=${version};INSERT INTO model_nodes(node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES('a','p','m','root-a','persona','memory:a'),('b','p','m','root-b','persona','memory:b');INSERT INTO topics(topic_id,created_by,title,initial_prompt,max_model_turns,max_turns_per_node,used_model_turns,deadline_at) VALUES('topic','u','Legacy','test',2,1,1,'2099-01-01T00:00:00Z');INSERT INTO topic_participants(topic_id,node_id) VALUES('topic','a'),('topic','b');`);
 db.prepare('INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status) VALUES(?,?,?,?,?)').run('old-turn','topic','a','root-a',status);db.close();
}

for(let version=1;version<=7;version++)test(`P5-H1 backup refuses running turns in supported schema v${version}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-legacy-running-')),database=join(dir,'db.sqlite');
 try{legacy(database,version);await assert.rejects(createBackup(database,join(dir,'backup')),{code:'CONFLICT'});const db=new DatabaseSync(database,{readOnly:true});try{assert.equal((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,version);assert.equal((db.prepare('SELECT status FROM model_turns').get() as {status:string}).status,'running');}finally{db.close();}}
 finally{rmSync(dir,{recursive:true,force:true});}
});

test('P5-H1 existing legacy artifacts with running activities are rejected by verification and restore',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-old-artifact-')),database=join(dir,'db.sqlite'),bundle=join(dir,'backup');
 try{
  legacy(database,1);mkdirSync(bundle);const snapshot=join(bundle,'database.sqlite');copyFileSync(database,snapshot);const db=new DatabaseSync(snapshot);db.exec('PRAGMA journal_mode=DELETE');db.close();const bytes=readFileSync(snapshot);
  const dependencies=JSON.parse(readFileSync('package.json','utf8')).dependencies;
  writeFileSync(join(bundle,'manifest.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),database,schemaVersion:1,platform:process.platform,sdk:dependencies['@deepseek-ai/dsh-sdk-client'],cordis:dependencies['@deepseek-ai/cordis'],runtimePresent:false,files:[{path:'database.sqlite',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
  await assert.rejects(verifyBackup(bundle),{code:'STORAGE'});await assert.rejects(restoreBackup(bundle,database),{code:'STORAGE'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('P5-H1 ambiguous unresolved legacy activities roll back migration instead of choosing a turn',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-ambiguous-legacy-')),database=join(dir,'db.sqlite');
 try{
  legacy(database,1,'unknown');const db=new DatabaseSync(database);db.exec("INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status) VALUES('second','topic','a','root-a','unknown')");db.close();assert.throws(()=>new DmnStore(database),{code:'STORAGE'});
  const verify=new DatabaseSync(database,{readOnly:true});try{assert.equal((verify.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,1);assert.equal((verify.prepare('SELECT count(*) n FROM model_turns').get() as {n:number}).n,2);}finally{verify.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('P5-H1 existing v3 lock identity is preserved while legacy unknown state stays quarantined',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-old-lock-')),database=join(dir,'db.sqlite');let store:DmnStore|undefined;
 try{
  legacy(database,3,'unknown');const db=new DatabaseSync(database);db.exec("INSERT INTO node_locks VALUES('a','old-turn','original-owner','2099-01-01T00:00:00Z','running')");db.close();store=new DmnStore(database);
  assert.deepEqual({...store.one<{turn_id:string;owner:string;state:string}>('SELECT turn_id,owner,state FROM node_locks')},{turn_id:'old-turn',owner:'original-owner',state:'quarantined'});
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

for(const version of [1,2,3,4])test(`P5-H1 v${version} upgrade quarantines legacy activity once without inventing execution evidence`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-legacy-upgrade-')),database=join(dir,'db.sqlite');let store:DmnStore|undefined;
 try{
  legacy(database,version);store=new DmnStore(database);
  assert.equal(store.one<{status:string}>('SELECT status FROM model_turns')!.status,'unknown');assert.equal(store.one<{state:string}>('SELECT state FROM node_locks')!.state,'quarantined');assert.equal(store.one<{status:string}>("SELECT status FROM model_nodes WHERE node_id='a'")!.status,'cooling');
  let calls=0;const runner=new TopicRunner(store,new DmnGateway(store),{async run(){calls++;throw Error('must not replay');}});
  assert.equal((await runner.reconcile('old-turn')).state,'unknown');await runner.drain();assert.equal(calls,0);
  assert.equal(store.one<{used_model_turns:number}>('SELECT used_model_turns FROM topics')!.used_model_turns,1);
  assert.equal(store.one<{n:number}>('SELECT count(*) n FROM runtime_results')!.n,0);
  store.close();store=new DmnStore(database);assert.equal(store.one<{n:number}>("SELECT count(*) n FROM events WHERE event_type='turn.legacy_quarantined'")!.n,1);
  store.close();store=undefined;await createBackup(database,join(dir,'backup'));assert.equal((await verifyBackup(join(dir,'backup'))).schemaVersion,8);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
