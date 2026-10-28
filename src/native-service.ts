import{createServer}from'node:net';
import{randomBytes}from'node:crypto';
import{StringDecoder}from'node:string_decoder';
import{z}from'zod';
import{OperatorService}from'./operator.ts';
import{DmnStore}from'./store.ts';
import{RecoveryManager}from'./operations.ts';
import{type RootRuntime}from'./runner.ts';
import{acquireNativeInstance,matchesSecret}from'./native-instance.ts';
import{requireNoClients}from'./maintenance.ts';
import{DmnError,fail}from'./errors.ts';
const envelope=z.strictObject({protocol:z.literal(1),id:z.string().uuid(),token:z.string().length(64),method:z.string().min(1).max(40),params:z.unknown(),ownerToken:z.string().length(64).optional()});
export async function startNativeService(database:string,nodes:unknown,runtime:RootRuntime,options:{canInfer?:boolean}={}){
 const ownership=acquireNativeInstance(database),ownerToken=randomBytes(32).toString('hex');let store:DmnStore|undefined,listener:ReturnType<typeof createServer>|undefined;
 let phase:'ready'|'stopping'|'stopped'='ready',active:Promise<void>|undefined,timer:NodeJS.Timeout|undefined,requested=false,closing:Promise<void>|undefined,management:Promise<unknown>|undefined;
 try{
  requireNoClients(database);store=new DmnStore(database);const liveStore=store,operator=new OperatorService(store,nodes,runtime),recovery=new RecoveryManager(store,runtime,()=>new Date(),'desktop-user');
  const wake=()=>{if(phase!=='ready'||management)return;requested=true;if(timer)clearTimeout(timer);if(active)return;
   active=(async()=>{try{do{requested=false;await operator.drain(()=>phase==='ready');}while(requested&&phase==='ready');}catch{/* State/queue contain the sanitized failure. */}finally{active=undefined;const due=operator.nextWake();if(phase==='ready'&&due&&Date.parse(due)>Date.now())timer=setTimeout(wake,Math.min(60000,Date.parse(due)-Date.now()));}})();
  };
  const stop=()=>{if(closing)return closing;phase='stopping';if(timer)clearTimeout(timer);closing=(async()=>{await management?.catch(()=>{});await active;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));liveStore.close();ownership.release();phase='stopped';})();return closing;};
  const dispatch=async(method:string,params:unknown,key?:string)=>{
   if(method==='__stop'){if(!matchesSecret(key,ownerToken))fail('FORBIDDEN','Only the owning Host may stop this service.');phase='stopping';setImmediate(()=>void stop().catch(()=>{}));return{accepted:true,phase:'stopping'};}
   if(['state','nodes','topics','queue','pump'].includes(method)&&!z.strictObject({}).safeParse(params).success)fail('VALIDATION','Expected empty parameters.');
   if(['recover','reconcile','drop'].includes(method)){
    if(!matchesSecret(key,ownerToken))fail('FORBIDDEN','Owning Host maintenance capability required.');
    if(phase!=='ready'||active||management)fail('CONFLICT','Stop active scheduling before recovery.');
    if(method==='recover'&&!z.strictObject({}).safeParse(params).success)fail('VALIDATION','Expected empty parameters.');
    management=Promise.resolve().then(async():Promise<unknown>=>method==='recover'?recovery.quarantineExpired():method==='reconcile'?recovery.reconcile(params):recovery.drop(params));
    try{return await management;}finally{management=undefined;}
   }
   if(method==='state')return{protocol:1,instanceId:ownership.descriptor.instanceId,pid:process.pid,phase,credentialConfigured:options.canInfer!==false,nodes:operator.list(),topics:operator.listTopics(),modelCalls:liveStore.one<{n:number}>("SELECT count(*) n FROM model_turns WHERE status<>'queued'")!.n};
   if(['start','send','resume','pump'].includes(method)&&options.canInfer===false)fail('FORBIDDEN','Configure the provider credential before inference.');
   if(['start','send','pause','resume','close','pump','setNodePrompt'].includes(method)&&(phase!=='ready'||management))fail('CONFLICT','Native service is stopping; writes are refused.');
   let result:unknown;
   switch(method){
    case'nodePrompt':return operator.nodePrompt(params);case'setNodePrompt':return operator.setNodePrompt(params);case'nodes':return operator.list();case'topics':return operator.listTopics();case'topicState':return operator.get(params);case'messages':return operator.messages(params);case'metrics':return operator.metrics(params);
    case'queue':return{pending:recovery.list(),turns:liveStore.all('SELECT turn_id AS turnId,node_id AS nodeId,topic_id AS topicId,status,attempt_number AS attempt,output_action AS action,effects_suppressed AS suppressed FROM model_turns ORDER BY rowid DESC LIMIT 100'),deadLetters:liveStore.all('SELECT * FROM dead_letters ORDER BY created_at DESC LIMIT 100')};case'proof':return recovery.inspect(params);
    case'start':result=operator.start(params);break;case'send':result=operator.send(params);break;case'pause':return operator.pause(params);case'resume':result=operator.resume(params);break;case'close':return operator.close(params);case'pump':result={accepted:true};break;
    default:fail('VALIDATION','Unsupported native operation.');
   }
   setImmediate(wake);return result;
  };
  const server=listener=createServer(socket=>{let bytes=0,buffer='',handled=false;const decoder=new StringDecoder('utf8');socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});
   socket.on('data',async chunk=>{if(handled)return;bytes+=chunk.length;if(bytes>65536){handled=true;socket.end(JSON.stringify({ok:false,error:{code:'VALIDATION'}})+'\n');return;}buffer+=decoder.write(chunk);if(!buffer.includes('\n'))return;handled=true;let id:unknown;
    try{const parsed=envelope.safeParse(JSON.parse(buffer.split('\n')[0]!));if(!parsed.success)fail('VALIDATION','Invalid native envelope.');const x=parsed.data;id=x.id;if(!matchesSecret(x.token,ownership.descriptor.token))fail('FORBIDDEN','Native capability mismatch.');const result=await dispatch(x.method,x.params,x.ownerToken);socket.end(JSON.stringify({id,ok:true,result})+'\n');}
    catch(error){socket.end(JSON.stringify({id,ok:false,error:{code:error instanceof DmnError?error.code:'STORAGE'}})+'\n');}
   });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(ownership.descriptor.address,resolve);});ownership.publish();
  return{descriptor:ownership.descriptor,ownerToken,stop,get phase(){return phase;}};
 }catch(error){if(listener?.listening)await new Promise<void>(r=>listener!.close(()=>r()));store?.close();ownership.release();throw error;}
}
