import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DmnStore } from '../src/store.ts';
import { DmnGateway } from '../src/gateway.ts';
import { TopicManager } from '../src/topic-manager.ts';
import { TopicRunner,RuntimeNotSubmittedError } from '../src/runner.ts';
import { setup } from './fixtures.ts';
const limits={maxInputTokens:100000,maxOutputTokens:10000,maxEstimatedCost:2,inputTokensPerTurn:8000,outputTokensPerTurn:512,estimatedCostPerTurn:0.1,turnTimeoutMs:5000};
test('P2 v4 migration preserves spent topic/node reservations and legacy authorization without rebootstrap',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dmn-policy-migration-'));const path=join(dir,'queue.sqlite');
  try{
    const legacy=new DatabaseSync(path);
    for(const name of ['001_init.sql','002_node_capabilities.sql','003_runtime.sql','004_memory.sql'])legacy.exec(readFileSync(new URL(`../sql/${name}`,import.meta.url),'utf8'));
    for(const id of ['a','b'])legacy.prepare("INSERT INTO model_nodes(node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES(?,'p','m',?,'persona.md',?)").run(id,`session-${id}`,`memory:${id}`);
    legacy.exec("INSERT INTO topics(topic_id,created_by,title,initial_prompt,status,max_model_turns,max_turns_per_node,used_model_turns,deadline_at) VALUES('topic','human','old','old','waiting',5,3,1,'2026-10-26T00:15:00.000Z'); INSERT INTO topic_participants(topic_id,node_id) VALUES('topic','a'),('topic','b'); INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status,sdk_receipt_id) VALUES('old-turn','topic','a','session-a','completed','old-receipt'); PRAGMA user_version=4;");
    legacy.prepare('INSERT INTO topic_execution VALUES(?,?,8000,512,0.1)').run('topic',JSON.stringify(limits));legacy.close();
    const store=new DmnStore(path);
    try{
      assert.equal(JSON.parse(store.one<{limits_json:string}>('SELECT limits_json FROM topic_execution')!.limits_json).maxAttempts,3);
      const manager=new TopicManager(store,()=>new Date('2026-10-26T00:00:00Z'));manager.authorize('topic',limits);
      assert.equal(store.one<{user_version:number}>('PRAGMA user_version')?.user_version,8);
      assert.equal(store.one<{used_turns:number;reserved_input_tokens:number}>("SELECT * FROM node_budgets WHERE node_id='a'")?.reserved_input_tokens,8000);
      assert.equal(manager.get('topic').usedTurns,1);
      new TopicRunner(store,new DmnGateway(store),{async run(){throw Error('must not call');}},()=>new Date('2026-10-26T00:00:00Z')).seed('topic','a');
      assert.equal(store.one<{n:number}>('SELECT count(*) AS n FROM model_turns')?.n,1);
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('P2 retry backoff and attempt counters survive database reopen',async()=>{
  const f=setup();let calls=0;let time=Date.parse('2026-10-26T00:00:00Z');
  try{
    const runtime={async run(input:{node:{sessionId:string}},receipt:(id:string)=>void){calls++;if(calls===1)throw new RuntimeNotSubmittedError();receipt('r');return{text:'{"action":"silent"}',sessionId:input.node.sessionId};}};
    const runner=new TopicRunner(f.store,f.gateway,runtime,()=>new Date(time));runner.authorize(f.topic.id,{...limits,backoffSeconds:[5]});f.a.send({topicId:f.topic.id,to:'b',content:'restart'});await runner.drain();f.store.close();
    const reopened=new DmnStore(f.path);
    try{
      const second=new TopicRunner(reopened,new DmnGateway(reopened,()=>new Date(time)),runtime,()=>new Date(time));
      await second.drain();assert.equal(calls,1);time+=5000;await second.drain();assert.equal(calls,2);
      assert.equal(reopened.one<{attempts:number}>('SELECT attempts FROM deliveries')?.attempts,2);
      assert.equal(reopened.one<{used_model_turns:number}>('SELECT used_model_turns FROM topics')?.used_model_turns,2);
    }finally{reopened.close();}
  }finally{f.cleanup();}
});
test('P2 quota authorization rejects nonparticipants and larger node allowances atomically',()=>{
  const f=setup();
  try{
    const manager=new TopicManager(f.store);
    assert.throws(()=>manager.authorize(f.topic.id,{...limits,nodeLimits:{c:{maxInputTokens:1}}}),{code:'FORBIDDEN'});
    assert.throws(()=>manager.authorize(f.topic.id,{...limits,nodeLimits:{a:{maxEstimatedCost:100}}}),{code:'VALIDATION'});
    assert.equal(f.store.one<{n:number}>('SELECT count(*) AS n FROM topic_execution')?.n,0);
  }finally{f.cleanup();}
});
