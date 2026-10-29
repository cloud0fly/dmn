// Exact-route metadata owns valid controls; never infer from a provider/model name.
export function sharedModelInfo(info,binding,limits){
 if(!info.context||info.context.contextWindow<32768)throw Error('BROKER_FORBIDDEN');
 let reasoning=info.reasoning;
 if(reasoning){
  if(!Array.isArray(reasoning.efforts)||!reasoning.efforts.length)throw Error('BROKER_FORBIDDEN');
  const efforts=reasoning.efforts.map(e=>({id:e.id,name:e.name}));
  if(efforts.some(e=>typeof e.id!=='string'||!e.id||e.id.length>128||typeof e.name!=='string'))throw Error('BROKER_FORBIDDEN');
  const defaultEffort=reasoning.defaultEffort??(efforts.some(e=>e.id==='off')?undefined:efforts[0].id);
  if(defaultEffort!==undefined&&!efforts.some(e=>e.id===defaultEffort))throw Error('BROKER_FORBIDDEN');
  reasoning={efforts,...(defaultEffort===undefined?{}:{defaultEffort})};
 }
 return{provider:binding.provider,id:binding.model,name:String(info.name||binding.model),context:{contextWindow:Math.min(info.context.contextWindow,limits.inputTokensPerTurn)},defaultMaxTokens:limits.outputTokensPerTurn,...(reasoning?{reasoning}:{}),...(info.systemPromptUpdate?{systemPromptUpdate:info.systemPromptUpdate}:{})};
}
