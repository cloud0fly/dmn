import{listSharedModels}from'./model-catalog.mjs';import{startModelBroker}from'./model-broker.mjs';import{createRoomsRoute}from'./model-rooms.mjs';import{prepareModelRoom}from'./prepare-room.mjs';
import{NativeSettings}from'./settings.mjs';
import{createSettingsRoute}from'./settings-route.mjs';
import{mkdirSync,appendFileSync}from'node:fs';
import{join}from'node:path';
import{createBridge}from'./bridge.mjs';
import{createServiceManager}from'./service-manager.mjs';
import{DatabaseSync}from'node:sqlite';
import{fileURLToPath}from'node:url';
export const name='dmn-native';
export const inject=['connection','credentials','llm'];
const database=fileURLToPath(new URL('../../.dmn/n0/probe.sqlite',import.meta.url));
export function createReadOnlyStatus(path=database){return async request=>{
 if(request.method!=='GET')return Response.json({error:'READ_ONLY'},{status:405});
 if([...new URL(request.url).searchParams.keys()].length)return Response.json({error:'VALIDATION'},{status:400});
 let db;
 try{db=new DatabaseSync(path,{readOnly:true});if(![7,8].includes(db.prepare('PRAGMA user_version').get().user_version))throw Error();
  return Response.json({protocol:1,mode:'read-only-probe',nodes:db.prepare('SELECT node_id AS id,model_id AS model,status AS state FROM model_nodes ORDER BY node_id').all(),modelCalls:db.prepare('SELECT count(*) n FROM model_turns').get().n},{headers:{'cache-control':'no-store'}});
 }catch{return Response.json({error:'PROBE_UNAVAILABLE'},{status:503});}finally{db?.close();}
};}
export function apply(ctx,input={}){
 const settings=new NativeSettings(input.settingsDirectory);
 const createManager=()=>{const config=settings.read();let broker;const manager=createServiceManager({database:config.database,models:config.models,sharedRoutes:config.sharedRoutes,host:async()=>{broker??=await startModelBroker({database:config.database,llm:ctx.llm});return broker.descriptor;},credential:async()=>config.sharedRoutes?undefined:(await ctx.credentials?.resolve(config.credentialRef))?.value??(config.credentialRef==='DMN_DEEPSEEK_API_KEY'?process.env.DEEPSEEK_API_KEY:undefined),log:entry=>{try{mkdirSync(config.logDirectory,{recursive:true});appendFileSync(join(config.logDirectory,'lifecycle.jsonl'),JSON.stringify({time:new Date().toISOString(),event:entry.event,pid:entry.pid})+'\n',{mode:0o600});}catch{}}});return{...manager,async close(){await manager.close();await broker?.close();}};};
 let manager=createManager(),changing=false;
 const port={request:(...args)=>{if(changing)throw Error('MAINTENANCE');return manager.request(...args);},manage:(...args)=>{if(changing)throw Error('MAINTENANCE');return manager.manage(...args);}};
 const change=async next=>{if(changing)throw Error('CONFLICT');changing=true;try{await manager.close();settings.save(next);}finally{manager=createManager();changing=false;}};
 const configRoute=createSettingsRoute({store:settings,credentials:ctx.credentials,change});
 const catalog=()=>listSharedModels(ctx.llm),roomsRoute=createRoomsRoute({store:settings,catalog,readPrompt:nodeId=>manager.request('nodePrompt',{nodeId}),prepareRoom:prepareModelRoom,change});
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dmn-native/models',methods:['GET'],requestBody:'buffered',fetch:async request=>{if([...new URL(request.url).searchParams.keys()].length)return Response.json({error:'VALIDATION'},{status:400});try{return Response.json(await catalog(),{headers:{'cache-control':'no-store'}});}catch{return Response.json({error:'CATALOG_UNAVAILABLE'},{status:503});}}}));
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dmn-native/rooms',methods:['GET','POST'],requestBody:'buffered',fetch:roomsRoute}));
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dmn-native/settings',methods:['GET','POST'],requestBody:'buffered',fetch:configRoute}));
 ctx.effect(()=>()=>{void manager.close().catch(()=>{});});
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dmn-native/manage',methods:['POST'],requestBody:'buffered',fetch:createBridge(port,true)}));
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dmn-native/operate',methods:['POST'],requestBody:'buffered',fetch:createBridge(port)}));
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dmn-native/state',methods:['GET'],requestBody:'buffered',fetch:async request=>{if([...new URL(request.url).searchParams.keys()].length)return Response.json({error:'VALIDATION'},{status:400});try{return Response.json(await manager.request('state'),{headers:{'cache-control':'no-store'}});}catch{return Response.json({error:'INSTANCE_UNAVAILABLE'},{status:503});}}}));}
