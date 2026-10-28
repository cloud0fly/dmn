import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DmnStore} from '../src/store.ts';

test('P3 v5 migration preserves existing seed/result and allows multiple distinct human inputs without reusing the seed slot',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dmn-p3-migration-')),path=join(dir,'db.sqlite');
  try{
    const old=new DatabaseSync(path);
    for(const name of ['001_init.sql','002_node_capabilities.sql','003_runtime.sql','004_memory.sql','005_policy_recovery.sql'])old.exec(readFileSync(new URL(`../sql/${name}`,import.meta.url),'utf8'));
    old.exec(`INSERT INTO model_nodes(node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES('a','p','m','root','a.md','own');
      INSERT INTO topics(topic_id,created_by,title,initial_prompt,max_model_turns,max_turns_per_node,deadline_at) VALUES('t','user','t','t',5,5,'2030-01-01T00:00:00Z');
      INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status) VALUES('seed','t','a','root','completed');
      INSERT INTO runtime_results VALUES('seed','a','{"text":"retained"}','2026-10-26'); PRAGMA user_version=5;`);old.close();
    for(let pass=0;pass<2;pass++){
      const store=new DmnStore(path);try{
        assert.equal(store.one<{user_version:number}>('PRAGMA user_version')!.user_version,8);
        assert.equal(store.one<{result_json:string}>('SELECT result_json FROM runtime_results')!.result_json,'{"text":"retained"}');
        if(pass===0)for(const key of ['one','two']){
          store.run("INSERT INTO operator_messages VALUES(?,'t','desktop-user','a','text',?,'2026-10-26')",key,key);
          store.run("INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status,operator_message_id) VALUES(?,'t','a','root','queued',?)",key,key);
        }
        assert.equal(store.one<{n:number}>('SELECT count(*) n FROM model_turns')!.n,3);
      }finally{store.close();}
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
