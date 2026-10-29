import assert from 'node:assert/strict';
import{test}from'node:test';
import{mkdtempSync,rmSync,readFileSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{DatabaseSync}from'node:sqlite';
import{createReadOnlyStatus,apply}from'../host.mjs';
test('N0 host exposes only fixed-database public metadata and never writes or infers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-n0-')),path=join(dir,'qa.sqlite');
 try{const db=new DatabaseSync(path);db.exec("CREATE TABLE model_nodes(node_id TEXT,model_id TEXT,status TEXT);CREATE TABLE model_turns(status TEXT);INSERT INTO model_nodes VALUES('a','<img src=x>','sleeping');PRAGMA user_version=7");db.close();
 const handler=createReadOnlyStatus(path);const response=await handler(new Request('http://localhost/api/dmn-native/probe'));assert.equal(response.status,200);const body=await response.json();assert.equal(body.nodes[0].id,'a');assert.equal(body.modelCalls,0);assert(!JSON.stringify(body).includes(path));
 assert.equal((await handler(new Request('http://localhost/api/dmn-native/probe?database=other'))).status,400);assert.equal((await handler(new Request('http://localhost/api/dmn-native/probe',{method:'POST'}))).status,405);
 const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('SELECT count(*) n FROM model_turns').get().n,0);check.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('N0 host registration is owned and disposed; bad storage errors omit raw paths',async()=>{
 let route,removed=0;const effects=[];apply({effect(fn){effects.push(fn());},connection:{fetch:{register(value){route=value;return()=>removed++;}}}});
 assert.deepEqual(route.methods,['GET']);for(const dispose of effects.reverse())dispose();assert.equal(removed,6);
 const response=await createReadOnlyStatus('nonexistent-private-path')(new Request('http://localhost/api/dmn-native/probe'));assert.equal(response.status,503);assert(!JSON.stringify(await response.json()).includes('nonexistent-private-path'));
});
test('N0 built client declares only native public slots and no HTML execution/model submission',()=>{
 const source=readFileSync(new URL('../src/client.cjs',import.meta.url),'utf8');assert(source.includes("name:'main'"));assert(source.includes("name:'sidebar.panellist'"));assert(!/dangerouslySetInnerHTML|innerHTML|session\/prompt|send_message|new Function|eval\(/.test(source));
});
