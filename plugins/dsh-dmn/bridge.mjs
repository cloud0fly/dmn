const business=new Set(['nodePrompt','setNodePrompt','lifecycle','state','start','send','nodes','topics','topicState','messages','pause','resume','close','queue','proof','metrics']);
const maintenance=new Set(['recover','reconcile','drop','backup','verify','restore','retire']);
export function createBridge(manager,administrative=false){return async request=>{
 if(request.method!=='POST')return Response.json({error:'METHOD'},{status:405});
 if(request.headers.get(administrative?'x-dmn-maintenance':'x-dmn-operator')!=='1'||!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'FORBIDDEN'},{status:403});
 const origin=request.headers.get('origin');if(origin&&origin!=='dsh-app://app'&&origin!==new URL(request.url).origin)return Response.json({error:'FORBIDDEN'},{status:403});
 try{const text=await request.text();if(Buffer.byteLength(text)>65536)return Response.json({error:'VALIDATION'},{status:400});const x=JSON.parse(text);
 if(!x||Object.keys(x).sort().join(',')!=='method,params'||!(administrative?maintenance:business).has(x.method))return Response.json({error:'VALIDATION'},{status:400});
 const mutates=administrative||['start','send','pause','resume','close','setNodePrompt','nodePrompt'].includes(x.method),bound=mutates?request.headers.get('x-dmn-instance'):undefined;if(mutates&&!/^[a-f0-9]{32}$/.test(bound??''))return Response.json({error:'INSTANCE_REQUIRED'},{status:400});
 return Response.json({result:await (administrative?manager.manage(x.method,x.params,bound??undefined):manager.request(x.method,x.params,bound??undefined))},{headers:{'cache-control':'no-store'}});
 }catch(error){const code=String(error?.code??error?.message);return Response.json({error:/^[A-Z_]{2,40}$/.test(code)?code:'UNCONFIRMED'},{status:409});}
 };}
