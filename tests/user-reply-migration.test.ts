import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DmnStore} from '../src/store.ts';
test('P4 v6 migration preserves history, defaults to discussion and is repeatable',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-v7-')),path=join(dir,'db.sqlite');
 try{const db=new DatabaseSync(path);
 for(const file of ['001_init','002_node_capabilities','003_runtime','004_memory','005_policy_recovery','006_desktop_operator'])db.exec(readFileSync(new URL(`../sql/${file}.sql`,import.meta.url),'utf8'));
 db.exec(`INSERT INTO model_nodes(node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES('a','p','m','s','p.md','own');
 INSERT INTO topics(topic_id,created_by,title,initial_prompt,max_model_turns,max_turns_per_node,deadline_at) VALUES('t','user','t','t',5,5,'2030-01-01T00:00:00Z');
 INSERT INTO operator_messages VALUES('input','t','desktop-user','a','hello','key','2026-10-27'); PRAGMA user_version=6;`);db.close();
 for(let i=0;i<2;i++){const store=new DmnStore(path);try{
 assert.equal(store.one<{user_version:number}>('PRAGMA user_version')!.user_version,8);
 assert.equal(store.one<{interaction_mode:string}>('SELECT interaction_mode FROM topics')!.interaction_mode,'discussion');
 assert.equal(store.one<{content:string}>('SELECT content FROM operator_messages')!.content,'hello');
 assert.equal(store.one<{n:number}>('SELECT count(*) n FROM user_replies')!.n,0);
 }finally{store.close();}}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
