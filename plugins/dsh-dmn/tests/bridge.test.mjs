import assert from'node:assert/strict';import{test}from'node:test';import{createBridge}from'../bridge.mjs';
test('N2 bridge refuses forged Host operations, paths, origins and transport bypass',async()=>{
 const calls=[],bridge=createBridge({async request(...args){calls.push(args);return{accepted:true};}});
 const request=(body,headers={})=>new Request('http://local/api/dmn-native/operate',{method:'POST',headers:{'content-type':'application/json','x-dmn-operator':'1','x-dmn-instance':'a'.repeat(32),...headers},body:JSON.stringify(body)});
 for(const body of [{method:'__stop',params:{}},{method:'send',params:{},database:'evil'},{method:'drop',params:{}},null])assert.equal((await bridge(request(body))).status,400);
 assert.equal((await bridge(request({method:'send',params:{}},{origin:'https://evil.test'}))).status,403);
 assert.equal((await bridge(request({method:'send',params:{}},{'x-dmn-operator':''}))).status,403);assert.equal(calls.length,0);assert.equal((await bridge(request({method:'send',params:{}},{'x-dmn-instance':''}))).status,400);
 assert.equal((await bridge(request({method:'send',params:{topicId:'x',to:'b',content:'<script>test</script>',idempotencyKey:'one'}}))).status,200);assert.equal(calls.length,1);assert.equal(calls[0][1].to,'b');
});
test('N3 maintenance uses a separate capability route and never crosses from business calls',async()=>{
 const calls=[],manager={async request(){throw Error('unexpected');},async manage(...args){calls.push(args);return{inferenceStarted:false};}},admin=createBridge(manager,true),business=createBridge(manager);
 const request=(header)=>new Request('http://local/api/dmn-native/manage',{method:'POST',headers:{'content-type':'application/json',[header]:'1','x-dmn-instance':'a'.repeat(32)},body:JSON.stringify({method:'backup',params:{}})});
 assert.equal((await admin(request('x-dmn-operator'))).status,403);assert.equal((await business(request('x-dmn-maintenance'))).status,403);
 assert.equal((await admin(request('x-dmn-maintenance'))).status,200);assert.deepEqual(calls,[['backup',{},'a'.repeat(32)]]);
});

test('G1 prompt operations require a trusted origin and exact bound instance',async()=>{
 const calls=[],bridge=createBridge({async request(...args){calls.push(args);return{revision:1};}});
 for(const method of ['nodePrompt','setNodePrompt']){const make=headers=>new Request('http://local/api/dmn-native/operate',{method:'POST',headers:{'content-type':'application/json','x-dmn-operator':'1',...headers},body:JSON.stringify({method,params:{nodeId:'a'}})});assert.equal((await bridge(make({}))).status,400);assert.equal((await bridge(make({'x-dmn-instance':'a'.repeat(32),origin:'https://evil.test'}))).status,403);assert.equal((await bridge(make({'x-dmn-instance':'a'.repeat(32)}))).status,200);}
 assert(calls.every(c=>c[2]==='a'.repeat(32)));
});
