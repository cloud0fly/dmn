import {DmnStore} from './store.ts';
import {OperatorService} from './operator.ts';
import {configuredNodes,sharedRoutesSchema} from './shared-nodes.ts';
import {z} from 'zod';
import {existsSync,mkdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const [database,root]=process.argv.slice(2);
process.once('message',request=>{
 let store:DmnStore|undefined;
 try{
  if(!database||!root)throw Error('CONFLICT');
  const {routes,prompts}=z.strictObject({routes:sharedRoutesSchema,prompts:z.tuple([z.string().max(8000).nullable(),z.string().max(8000).nullable()])}).parse(request);
  const runtime=database+'.runtime',receipt=join(runtime,'room-prepared.json');
  const fingerprint=createHash('sha256').update(JSON.stringify({database,routes,prompts})).digest('hex');
  // Completed initialization can be retried after a lost IPC acknowledgement.
  // A partial database without a receipt stays isolated, never overwritten.
  if(existsSync(database)){
   if(lstatSync(database).isSymbolicLink()||lstatSync(runtime).isSymbolicLink()||lstatSync(receipt).isSymbolicLink()||JSON.parse(readFileSync(receipt,'utf8')).fingerprint!==fingerprint)throw Error('CONFLICT');
  }else{
   store=new DmnStore(database);
   const op=new OperatorService(store,configuredNodes(root,database,routes),{async run(){throw Error('Room creation never infers');}});
   for(let i=0;i<2;i++)if(prompts[i])op.setNodePrompt({nodeId:i?'reviewer':'deepseek',revision:0,systemPrompt:prompts[i],idempotencyKey:'initial-persona'});
   store.close();store=undefined;
   mkdirSync(runtime,{recursive:true});
   if(lstatSync(runtime).isSymbolicLink())throw Error('CONFLICT');
   writeFileSync(receipt,JSON.stringify({fingerprint}),{flag:'wx',mode:0o600});
  }
  process.send?.({ok:true});
 }catch{process.send?.({ok:false,error:'ROOM_CREATE_FAILED'});}
 finally{store?.close();if(process.connected)process.disconnect();}
});
