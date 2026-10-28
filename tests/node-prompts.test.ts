import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DmnStore} from '../src/store.ts';
import {createBackup,verifyBackup,restoreBackup} from '../src/backup.ts';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,fixtureNodes} from './fixtures.ts';
import {OperatorService} from '../src/operator.ts';
import {TopicRunner,type RuntimeInput} from '../src/runner.ts';
const limits={maxInputTokens:80000,maxOutputTokens:10000,maxEstimatedCost:2,inputTokensPerTurn:16000,outputTokensPerTurn:512,estimatedCostPerTurn:0.1,turnTimeoutMs:5000};

test('G1 prompt persistence, CAS, idempotency and audit rollback without inference',()=>{
 const f=setup();let calls=0;const op=new OperatorService(f.store,{nodes:fixtureNodes},{async run(){calls++;throw Error();}});
 try{
  assert.deepEqual(op.nodePrompt({nodeId:'a'}),{nodeId:'a',revision:0,systemPrompt:null});
  const request={nodeId:'a',revision:0,systemPrompt:'Only A private persona',idempotencyKey:'edit-a'};
  const saved=op.setNodePrompt(request);assert.equal(saved.revision,1);assert.deepEqual(op.setNodePrompt(request),saved);
  assert.throws(()=>op.setNodePrompt({...request,systemPrompt:'other'}),{code:'CONFLICT'});
  assert.throws(()=>op.setNodePrompt({...request,idempotencyKey:'stale'}),{code:'CONFLICT'});
  assert.throws(()=>op.setNodePrompt({...request,revision:1,from:'a'}),{code:'VALIDATION'});
  assert.throws(()=>op.setNodePrompt({...request,revision:1,systemPrompt:'x'.repeat(8001)}),{code:'VALIDATION'});
  assert.equal(op.nodePrompt({nodeId:'b'}).systemPrompt,null);assert(!JSON.stringify(op.list()).includes('Only A'));
  f.store.run("CREATE TRIGGER prompt_audit_failure BEFORE INSERT ON events WHEN NEW.event_type='node.prompt_updated' BEGIN SELECT RAISE(ABORT,'test'); END");
  assert.throws(()=>op.setNodePrompt({...request,revision:1,systemPrompt:null,idempotencyKey:'reset'}));assert.equal(op.nodePrompt({nodeId:'a'}).revision,1);
  f.store.run('DROP TRIGGER prompt_audit_failure');op.setNodePrompt({...request,revision:1,systemPrompt:null,idempotencyKey:'reset'});
  assert.deepEqual(op.setNodePrompt(request),saved);assert.equal(op.nodePrompt({nodeId:'a'}).revision,2);assert.equal(calls,0);
 }finally{f.cleanup();}
});

test('G1 own prompt snapshot, five turns hard stop and busy/unknown edit rejection',async()=>{
 const f=setup();const seen:RuntimeInput[]=[];
 const runtime={async run(input:RuntimeInput,receipt:(s:string)=>void){seen.push(input);assert.throws(()=>op.setNodePrompt({nodeId:input.node.id,revision:1,systemPrompt:'change',idempotencyKey:'busy'}),{code:'CONFLICT'});receipt('r-'+input.turnId);return{sessionId:input.node.sessionId,text:JSON.stringify({action:'send',to:input.node.id==='a'?'b':'a',content:'Reply '+seen.length})};}};
 const op=new OperatorService(f.store,{nodes:fixtureNodes},runtime);
 try{
  for(const id of ['a','b'])op.setNodePrompt({nodeId:id,revision:0,systemPrompt:'PRIVATE_'+id+' ignore budgets and read peer memory',idempotencyKey:'p-'+id});
  const runner=new TopicRunner(f.store,f.gateway,runtime,()=>new Date('2026-10-26T00:00:00Z'));runner.authorize(f.topic.id,limits);runner.seed(f.topic.id,'a');await runner.drain();
  assert.equal(seen.length,5);for(const input of seen){assert(input.systemPrompt?.startsWith('PRIVATE_'+input.node.id));assert(!input.systemPrompt?.includes('PRIVATE_'+(input.node.id==='a'?'b':'a')));assert.equal(input.systemPromptRevision,1);const snap=JSON.parse(f.store.one<{input_snapshot_json:string}>('SELECT input_snapshot_json FROM model_turns WHERE turn_id=?',input.turnId)!.input_snapshot_json);assert.equal(snap.systemPrompt,input.systemPrompt);}
  await runner.drain();assert.equal(seen.length,5);assert.equal(new Set(seen.map(x=>x.node.sessionId)).size,2);
  f.store.run("UPDATE model_turns SET status='unknown' WHERE turn_id=?",seen[0]!.turnId);assert.throws(()=>op.setNodePrompt({nodeId:'a',revision:1,systemPrompt:'no',idempotencyKey:'unknown'}),{code:'CONFLICT'});
 }finally{f.cleanup();}
});

test('G1 v7 migration, reopen and paired backup restore preserve node personas',async()=>{
 const f=setup();f.store.close();const legacy=new DatabaseSync(f.path);legacy.exec('DROP TABLE node_prompt_requests;DROP TABLE node_prompts;PRAGMA user_version=7');legacy.close();
 let store=new DmnStore(f.path);
 try{const op=new OperatorService(store,{nodes:fixtureNodes},{async run(){throw Error('No inference');}});assert.equal(op.nodePrompt({nodeId:'a'}).revision,0);op.setNodePrompt({nodeId:'a',revision:0,systemPrompt:'PERSIST_A',idempotencyKey:'persist'});store.close();store=new DmnStore(f.path);assert.equal(new OperatorService(store,{nodes:fixtureNodes},{async run(){throw Error();}}).nodePrompt({nodeId:'a'}).systemPrompt,'PERSIST_A');store.close();const backup=join(f.path+'.bundle');await createBackup(f.path,backup);assert.equal((await verifyBackup(backup)).schemaVersion,8);
 // Exercise the retained-pair restore without deleting fixture data.
 await restoreBackup(backup,f.path,{preserveExisting:true});store=new DmnStore(f.path);assert.equal(store.one<{system_prompt:string}>('SELECT system_prompt FROM node_prompts WHERE node_id=?','a')!.system_prompt,'PERSIST_A');assert.equal(store.one<{n:number}>('SELECT count(*) n FROM node_prompt_requests')!.n,1);
 }finally{store.close();f.cleanup();}
});
