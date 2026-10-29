import{fork}from'node:child_process';
import{createConnection}from'node:net';
import{randomUUID,createHash}from'node:crypto';
import{existsSync,readFileSync,mkdirSync,realpathSync,lstatSync}from'node:fs';
import{dirname,join}from'node:path';
import{fileURLToPath}from'node:url';
import{StringDecoder}from'node:string_decoder';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function pipeRequest(descriptor,method,params={},ownerToken){return new Promise((resolve,reject)=>{
 const id=randomUUID(),decoder=new StringDecoder('utf8');let buffer='',bytes=0,done=false;const socket=createConnection(descriptor.address);
 const finish=(error,result)=>{if(done)return;done=true;socket.destroy();error?reject(Error(error)):resolve(result);};
 socket.setTimeout(15000,()=>finish('UNCONFIRMED'));socket.on('error',()=>finish('UNCONFIRMED'));socket.on('end',()=>{if(!done)finish('UNCONFIRMED');});
 socket.on('connect',()=>{const message=JSON.stringify({protocol:1,id,token:descriptor.token,method,params,...(ownerToken?{ownerToken}:{})});if(Buffer.byteLength(message)>65536)return finish('VALIDATION');socket.write(message+'\n');});
 socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>10*1024*1024)return finish('STORAGE');buffer+=decoder.write(chunk);if(!buffer.includes('\n'))return;try{const x=JSON.parse(buffer.split('\n')[0]);if(x.id!==id)throw Error();x.ok?finish(undefined,x.result):finish(x.error?.code??'STORAGE');}catch{finish('PROTOCOL');}});
 });}
export function createServiceManager({database=join(root,'.dmn/native-dev/queue.sqlite'),credential=()=>undefined,nodePath,models,sharedRoutes,host,log=()=>{}}={}){
 mkdirSync(dirname(database),{recursive:true});if(existsSync(database)){const leaf=lstatSync(database);if(leaf.isSymbolicLink()||!leaf.isFile()||leaf.nlink>1)throw Error('FORBIDDEN');}const canonical=existsSync(database)?realpathSync(database):join(realpathSync(dirname(database)),database.split(/[\\/]/).at(-1));
 const instanceId=createHash('sha256').update(canonical).digest('hex').slice(0,32);
 let connection,starting,child,ownerToken,closed=false,maintaining=false,maintenanceTask;
 function discover(){if(!existsSync(canonical+'.native.owner'))return;for(const suffix of ['.native.owner','.native.endpoint'])if(lstatSync(canonical+suffix).isSymbolicLink())throw Error('CONFLICT');const owner=JSON.parse(readFileSync(canonical+'.native.owner','utf8')),x=JSON.parse(readFileSync(canonical+'.native.endpoint','utf8'));
 if(x.protocol!==1||x.pid!==owner.pid||x.bootId!==owner.bootId||x.instanceId!==owner.instanceId||x.instanceId!==instanceId||!/^[a-f0-9]{64}$/.test(x.token))throw Error('CONFLICT');return x;}
 async function connect(){if(closed)throw Error('STOPPING');if(connection)return connection;if(starting)return starting;
 starting=(async()=>{const existing=discover();if(existing){await pipeRequest(existing,'state');return connection=existing;}
 const bundled=join(dirname(process.execPath),'resources/runtime/primary-runtime/dependencies/node/bin/node.exe');const executable=nodePath??(existsSync(bundled)?bundled:process.execPath);
 const key=await credential();const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;if(key)env.DEEPSEEK_API_KEY=key;else delete env.DEEPSEEK_API_KEY;if(models)env.DMN_NODE_MODELS=JSON.stringify(models);if(sharedRoutes){if(!host)throw Error('HOST_MODELS_UNAVAILABLE');env.DMN_NODE_ROUTES=JSON.stringify(sharedRoutes);env.DMN_HOST_MODEL_BROKER=JSON.stringify(await host());delete env.DEEPSEEK_API_KEY;}else{delete env.DMN_NODE_ROUTES;delete env.DMN_HOST_MODEL_BROKER;}
 return await new Promise((resolve,reject)=>{let settled=false;child=fork(join(root,'src/native-service-main.ts'),[canonical,root],{execPath:executable,execArgv:['--import','tsx'],cwd:root,windowsHide:true,env,stdio:['ignore','ignore','ignore','ipc']});
 const timeout=setTimeout(()=>{if(!settled){settled=true;child.disconnect();reject(Error('START_TIMEOUT'));}},20000);
 child.once('message',message=>{if(settled)return;settled=true;clearTimeout(timeout);if(message.ready){connection=message.descriptor;ownerToken=message.ownerToken;log({event:'service.ready',pid:connection.pid});resolve(connection);}else reject(Error('INSTANCE_UNAVAILABLE'));});
 child.once('error',()=>{if(!settled){settled=true;clearTimeout(timeout);reject(Error('START_FAILED'));}});
 child.once('exit',()=>{connection=undefined;ownerToken=undefined;if(!settled){settled=true;clearTimeout(timeout);reject(Error('START_FAILED'));}});
 });})().finally(()=>{starting=undefined;});return starting;
 }
 async function stopOwned(){
  try{await starting;}catch{}if(!child||!ownerToken||!connection)return;
  const current=child,ended=new Promise((resolve,reject)=>{if(current.exitCode!==null)return resolve();const timeout=setTimeout(()=>reject(Error('STOP_TIMEOUT')),80000);current.once('exit',()=>{clearTimeout(timeout);resolve();});});
  await pipeRequest(connection,'__stop',{},ownerToken);if(current.connected)current.disconnect();await ended;log({event:'service.stopped',pid:current.pid});connection=undefined;ownerToken=undefined;child=undefined;
 }
 async function maintenance(operation,params){if(closed||maintaining)throw Error('CONFLICT');maintaining=true;
  maintenanceTask=(async()=>{if(operation!=='retire'){await connect();if(!ownerToken)throw Error('FORBIDDEN');await stopOwned();}
   const bundled=join(dirname(process.execPath),'resources/runtime/primary-runtime/dependencies/node/bin/node.exe');
   return await new Promise((resolve,reject)=>{const worker=fork(join(root,'src/native-maintenance-main.ts'),[canonical],{execPath:nodePath??(existsSync(bundled)?bundled:process.execPath),execArgv:['--import','tsx'],cwd:root,windowsHide:true,env:{PATH:process.env.PATH,Path:process.env.Path,SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,TEMP:process.env.TEMP,TMP:process.env.TMP},stdio:['ignore','ignore','ignore','ipc']});let got=false;
    worker.once('message',message=>{got=true;message.ok?resolve(message.result):reject(Error(message.error??'STORAGE'));});worker.once('error',()=>reject(Error('MAINTENANCE_FAILED')));worker.once('exit',()=>{if(!got)reject(Error('MAINTENANCE_UNCONFIRMED'));});worker.send({operation,params});
   });
  })();try{return await maintenanceTask;}finally{maintaining=false;maintenanceTask=undefined;}
 }
 return{async request(method,params={},expectedInstance){if(expectedInstance&&expectedInstance!==instanceId)throw Error('INSTANCE_CHANGED');if(method==='lifecycle'){if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length)throw Error('VALIDATION');let owner;try{owner=existsSync(canonical+'.native.owner')?JSON.parse(readFileSync(canonical+'.native.owner','utf8')):undefined;}catch{return{instanceId,blocked:true,reason:'INVALID_OWNER_METADATA'};}let alive=false;if(owner)try{process.kill(owner.pid,0);alive=true;}catch{}return{instanceId,owned:!!ownerToken,maintaining,ownerPid:owner?.pid??null,ownerProcessPresent:alive,blocked:!!owner&&!alive,automaticLockRemoval:false};}if(maintaining)throw Error('MAINTENANCE');const descriptor=await connect();return pipeRequest(descriptor,method,params);},async manage(method,params={},expectedInstance){if(expectedInstance&&expectedInstance!==instanceId)throw Error('INSTANCE_CHANGED');if(['backup','verify','restore','retire'].includes(method))return maintenance(method,params);if(!['recover','reconcile','drop'].includes(method))throw Error('VALIDATION');const descriptor=await connect();if(!ownerToken)throw Error('FORBIDDEN');return pipeRequest(descriptor,method,params,ownerToken);},async close(){closed=true;await maintenanceTask;await stopOwned();connection=undefined;},get owned(){return!!ownerToken;}};
}
