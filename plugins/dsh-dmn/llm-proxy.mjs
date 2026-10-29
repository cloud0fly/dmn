import{LlmAdapter,resolveRetryPolicy}from'@deepseek-ai/dsh-llm';import{brokerRequest}from'./broker-client.mjs';
export const name='dmn-host-llm';export const inject=['llm'];
export function apply(ctx){const binding=JSON.parse(process.env.DMN_HOST_LLM||'null');if(!binding)throw Error('Missing trusted Host binding');const request=(method,params)=>brokerRequest(binding.descriptor,method,{nodeId:binding.nodeId,turnId:binding.turnId,provider:binding.provider,model:binding.model,sessionId:binding.sessionId,...params});
 class Adapter extends LlmAdapter{
  providerInfo(provider){return{id:provider,name:'DSH configured provider'};}
  providerRetryPolicy(){return resolveRetryPolicy({mode:'normal',maxRetries:0});}
  async resolveModel(provider,model){if(provider!==binding.provider||model!==binding.model)throw Error('Bound model mismatch');return request('resolve',{});}
  async listModels(provider){return[await this.resolveModel(provider,binding.model)];}
  async *stream(options){if(options.signal?.aborted)throw Error('Cancelled');const {signal,...wire}=options;const chunks=await request('generate',{options:wire});for(const chunk of chunks){if(signal?.aborted)throw Error('Cancelled');yield chunk;}}
 }
 ctx.llm.registerAdapter([binding.provider],new Adapter());
}
