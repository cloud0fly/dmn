import {assertSchedulingOwner} from './native-instance.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseNodes, parseTopic } from './contracts.ts';
import { requestSchema } from './discussion.ts';
import { executionSchema, parseExecution } from './execution-contracts.ts';
import { fail } from './errors.ts';
import { DmnGateway } from './gateway.ts';
import { TopicRunner, type RootRuntime } from './runner.ts';
import { DmnStore } from './store.ts';
import { TopicManager } from './topic-manager.ts';
import {getMessagesPage} from './message-pages.ts';
import {readMetrics} from './operations.ts';
import { refreshNodeState } from './node-state.ts';

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const topicRef=z.strictObject({topicId:id});
export const startRequest=requestSchema.extend({limits:executionSchema,idempotencyKey:id,mode:z.enum(['discussion','direct']).default('discussion')});
export const operatorMessage=z.strictObject({topicId:id,to:id,content:z.string().trim().min(1).max(8000),idempotencyKey:id});
function checked<T>(schema:z.ZodType<T>,input:unknown):T {const result=schema.safeParse(input);if(!result.success)fail('VALIDATION','Invalid operator request.');return result.data;}

/** Trusted local Desktop operator only; never exposed to DMN node runtimes. */
export class OperatorService {
  private readonly gateway:DmnGateway;
  private readonly topics:TopicManager;
  private readonly runner:TopicRunner;
  private readonly operator='desktop-user';
  constructor(private readonly store:DmnStore,nodeConfig:unknown,runtime:RootRuntime){
    this.gateway=new DmnGateway(store);this.topics=new TopicManager(store);this.runner=new TopicRunner(store,this.gateway,runtime);
    store.transaction(()=>parseNodes(nodeConfig).forEach(node=>this.gateway.registerNode(node)));
  }
  start(input:unknown){
    const request=checked(startRequest,input);
    const {mode,...legacyRequest}=request;
    const normalized=JSON.stringify({...legacyRequest,limits:parseExecution(request.limits),...(mode==='direct'?{mode}: {})});
    if(!request.topic.participants.includes(request.startNode))fail('FORBIDDEN','Start node is not a participant.');
    return this.store.transaction(()=>{
      const prior=this.store.one<{request_json:string;topic_id:string}>('SELECT * FROM operator_requests WHERE operator_id=? AND idempotency_key=?',this.operator,request.idempotencyKey);
      if(prior){if(prior.request_json!==normalized)fail('CONFLICT','Idempotency key belongs to another topic request.');return {accepted:true,topicId:prior.topic_id};}
      const {durationMinutes,...topic}=request.topic;
      const created=this.gateway.createTopic(this.operator,parseTopic({...topic,deadlineAt:new Date(Date.now()+durationMinutes*60000).toISOString()}));
      this.store.run('UPDATE topics SET interaction_mode=? WHERE topic_id=?',request.mode,created.id);
      this.runner.authorize(created.id,request.limits);if(request.mode==='discussion')this.runner.seed(created.id,request.startNode);
      this.store.run('INSERT INTO operator_requests VALUES(?,?,?,?)',this.operator,request.idempotencyKey,normalized,created.id);
      return {accepted:true,topicId:created.id};
    });
  }
  send(input:unknown){
    const request=checked(operatorMessage,input);
    return this.store.transaction(()=>{
      const prior=this.store.one<{message_id:string;to_node:string;content:string}>('SELECT * FROM operator_messages WHERE operator_id=? AND topic_id=? AND idempotency_key=?',this.operator,request.topicId,request.idempotencyKey);
      if(prior){if(prior.to_node!==request.to||prior.content!==request.content)fail('CONFLICT','Idempotency key belongs to another message.');return {accepted:true,messageId:prior.message_id};}
      const topic=this.topics.row(request.topicId);
      if(!['active','waiting'].includes(topic.status)||topic.deadline_at<=new Date().toISOString())fail('TOPIC_STOPPED','Topic is paused, closed or expired.');
      if(topic.used_model_turns>=topic.max_model_turns)fail('BUDGET_EXHAUSTED','Topic turn budget exhausted.');
      if(!this.store.one('SELECT 1 FROM topic_participants WHERE topic_id=? AND node_id=?',request.topicId,request.to))fail('FORBIDDEN','Recipient is not a topic participant.');
      const messageId=randomUUID(),stamp=new Date().toISOString();
      this.store.run('INSERT INTO operator_messages VALUES(?,?,?,?,?,?,?)',messageId,request.topicId,this.operator,request.to,request.content,request.idempotencyKey,stamp);
      this.store.run("INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status,started_at,queue_created_at,operator_message_id) SELECT ?,?,node_id,session_id,'queued',?,?,? FROM model_nodes WHERE node_id=?",randomUUID(),request.topicId,stamp,stamp,messageId,request.to);
      this.store.run("UPDATE topics SET status='active' WHERE topic_id=?",request.topicId);
      this.store.run("INSERT INTO events(event_type,topic_id,node_id,message_id,created_at) VALUES('operator.message_queued',?,?,NULL,?)",request.topicId,request.to,stamp);
      refreshNodeState(this.store,request.to,stamp);return {accepted:true,messageId};
    });
  }
  nodePrompt(input:unknown){
    const {nodeId}=checked(z.strictObject({nodeId:id}),input);
    if(!this.store.one('SELECT 1 FROM model_nodes WHERE node_id=?',nodeId))fail('NOT_FOUND','Node does not exist.');
    const row=this.store.one<{revision:number;system_prompt:string|null}>('SELECT revision,system_prompt FROM node_prompts WHERE node_id=?',nodeId);
    return {nodeId,revision:row?.revision??0,systemPrompt:row?.system_prompt??null};
  }
  setNodePrompt(input:unknown){
    assertSchedulingOwner(this.store.path);
    const request=checked(z.strictObject({nodeId:id,revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),systemPrompt:z.string().trim().min(1).max(8000).nullable(),idempotencyKey:id}),input);
    return this.store.transaction(()=>{
      const normalized=JSON.stringify(request),prior=this.store.one<{request_json:string;result_json:string}>('SELECT request_json,result_json FROM node_prompt_requests WHERE node_id=? AND idempotency_key=?',request.nodeId,request.idempotencyKey);
      if(prior){if(prior.request_json!==normalized)fail('CONFLICT','Prompt request key belongs to different parameters.');return JSON.parse(prior.result_json) as {nodeId:string;revision:number;systemPrompt:string|null};}
      const current=this.nodePrompt({nodeId:request.nodeId});
      if(current.revision!==request.revision)fail('CONFLICT','Prompt revision changed; reload before editing.');
      if(this.store.one("SELECT 1 FROM node_locks WHERE node_id=?",request.nodeId)||this.store.one("SELECT 1 FROM model_turns WHERE node_id=? AND status IN ('running','unknown')",request.nodeId))fail('CONFLICT','Running or unknown node cannot change its prompt.');
      const result={nodeId:request.nodeId,revision:request.revision+1,systemPrompt:request.systemPrompt};
      this.store.run('INSERT INTO node_prompts VALUES(?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET revision=excluded.revision,system_prompt=excluded.system_prompt,updated_at=excluded.updated_at',request.nodeId,result.revision,request.systemPrompt,new Date().toISOString());
      this.store.run('INSERT INTO node_prompt_requests VALUES(?,?,?,?)',request.nodeId,request.idempotencyKey,normalized,JSON.stringify(result));
      this.store.run("INSERT INTO events(event_type,node_id,payload_json,created_at) VALUES('node.prompt_updated',?,?,?)",request.nodeId,JSON.stringify({operator:this.operator,revision:result.revision,idempotencyKey:request.idempotencyKey}),new Date().toISOString());
      return result;
    });
  }
  list(){return this.store.all('SELECT node_id AS id,provider,model_id AS model,session_id AS sessionId,status AS state FROM model_nodes ORDER BY node_id');}
  listTopics(){return this.store.all('SELECT topic_id AS id,title,status AS state,interaction_mode AS mode,used_model_turns AS usedTurns,deadline_at AS deadlineAt FROM topics ORDER BY rowid DESC LIMIT 100');}
  get(input:unknown){return this.topics.get(checked(topicRef,input).topicId);}
  messages(input:unknown){return getMessagesPage(this.store,input);}
  metrics(input:unknown={}){return readMetrics(this.store,input);}
  pause(input:unknown){const {topicId}=checked(topicRef,input);this.topics.pause(topicId);return this.topics.get(topicId);}
  resume(input:unknown){const {topicId}=checked(topicRef,input);this.topics.resume(topicId);return this.topics.get(topicId);}
  close(input:unknown){const {topicId}=checked(topicRef,input);this.topics.close(topicId);return this.topics.get(topicId);}
  async drain(shouldContinue?:()=>boolean){await this.runner.drain(shouldContinue); }
  nextWake(){return this.store.one<{wake:string|null}>(`SELECT min(wake) wake FROM (
    SELECT min(d.next_attempt_at,t.deadline_at) wake FROM deliveries d JOIN messages m ON m.message_id=d.message_id JOIN topics t ON t.topic_id=m.topic_id WHERE d.status='retry' AND t.status IN ('active','waiting')
    UNION ALL SELECT min(s.ready_at,t.deadline_at) FROM model_turns s JOIN topics t ON t.topic_id=s.topic_id WHERE s.status='queued' AND s.ready_at IS NOT NULL AND t.status IN ('active','waiting'))`)?.wake;}
}
