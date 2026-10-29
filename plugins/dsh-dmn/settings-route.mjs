import{existsSync}from'node:fs';import{DatabaseSync}from'node:sqlite';
export function validateBoundModels(settings){if(!existsSync(settings.database))return;let db;try{db=new DatabaseSync(settings.database,{readOnly:true});const rows=db.prepare('SELECT * FROM model_nodes').all();for(const row of rows){const index=['deepseek','reviewer'].indexOf(row.node_id);if(index<0||(settings.sharedRoutes?(row.provider!==settings.sharedRoutes[index].provider||row.model_id!==settings.sharedRoutes[index].model):row.model_id!==settings.models[index]))throw Error('IMMUTABLE_NODE_ROUTE');}}finally{db?.close();}}
export function createSettingsRoute({store,credentials,change}){
 const read=async()=>{const settings=store.read();return{settings,credentialConfigured:!!(await credentials?.describe(settings.credentialRef))?.configured||(settings.credentialRef==='DMN_DEEPSEEK_API_KEY'&&!!process.env.DEEPSEEK_API_KEY),compatibility:{desktop:'0.2.1-rc.3',sdk:'0.2.1-rc.3',protocol:1,schema:8},inferenceStarted:false};};
 return async request=>{try{
  if([...new URL(request.url).searchParams.keys()].length)throw Error('VALIDATION');
  if(request.method==='GET')return Response.json(await read(),{headers:{'cache-control':'no-store'}});
  if(request.method!=='POST')return Response.json({error:'METHOD'},{status:405});
  const origin=request.headers.get('origin');if(request.headers.get('x-dmn-settings')!=='1'||!request.headers.get('content-type')?.startsWith('application/json')||(origin&&origin!=='dsh-app://app'&&origin!==new URL(request.url).origin))return Response.json({error:'FORBIDDEN'},{status:403});
  const text=await request.text();if(Buffer.byteLength(text)>65536)throw Error('VALIDATION');const body=JSON.parse(text);
  if(!body||Object.keys(body).some(k=>!['settings','credentialValue'].includes(k)))throw Error('VALIDATION');const next=store.validate(body.settings);
  if(next.revision!==store.read().revision)throw Error('CONFLICT');validateBoundModels(next);
  if(body.credentialValue!==undefined&&(typeof body.credentialValue!=='string'||!body.credentialValue.trim()||body.credentialValue.length>16000||/[\r\n]/.test(body.credentialValue)))throw Error('VALIDATION');
  await change(next);if(body.credentialValue!==undefined)await credentials.set(next.credentialRef,body.credentialValue);return Response.json(await read(),{headers:{'cache-control':'no-store'}});
 }catch(error){const code=String(error?.message);return Response.json({error:/^[A-Z_]{2,50}$/.test(code)?code:'SETTINGS_FAILED'},{status:409});}};
}
