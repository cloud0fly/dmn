import {assertSchedulingOwner} from './native-instance.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseId, type ModelNode } from './contracts.ts';
import { DmnGateway } from './gateway.ts';
import { DmnError, fail } from './errors.ts';
import { DmnStore } from './store.ts';
import { MemoryManager } from './memory.ts';
import { decodeModelOutput } from './model-output.ts';
import { TopicManager } from './topic-manager.ts';
import { refreshNodeState } from './node-state.ts';
import { type ExecutionLimits } from './execution-contracts.ts';
export type { ExecutionLimits } from './execution-contracts.ts';
export type RuntimeInput = { node: ModelNode; topicId: string; turnId: string; prompt: string; systemPrompt?: string; systemPromptRevision?: number; resume: boolean; limits: ExecutionLimits };
export type RuntimeResult = { text: string; sessionId: string; usage?: Record<string, number> | undefined; eventOffset?: number | undefined };
export type Inspection = { state: 'completed'; result: RuntimeResult; receiptId: string } | { state: 'unknown'; reason: string; quiescent: boolean };
export interface RootRuntime {
  run(input: RuntimeInput, onReceipt: (receiptId: string) => void): Promise<RuntimeResult>;
  inspect?(input: RuntimeInput, receiptId: string | null): Promise<Inspection>;
}
/** Only trusted adapters may assert this, after proving no prompt dispatch and successful cleanup. */
export class RuntimeNotSubmittedError extends DmnError {
  constructor(public readonly retryable = true) { super('TOPIC_STOPPED', 'Runtime failed before submitting this input; process cleanup was confirmed.'); }
}
type Turn = { turn_id: string; node_id: string; topic_id: string; input_message_id: string | null; operator_message_id: string | null; sdk_receipt_id: string | null;
  attempt_number: number; retry_of: string | null; topic_epoch: number; status: string; input_snapshot_json: string | null };
type Envelope = { message_id: string; from_node: string; to_node: string; content: string; type: string; expires_at: string | null; attempts: number };
const resultSchema = z.strictObject({ text: z.string().max(16000), sessionId: z.string().min(1),
  usage: z.record(z.string(),z.number().nonnegative().finite()).optional(), eventOffset: z.number().int().nonnegative().optional() });

/** Bounded host-controlled pump. All model-facing identities are fixed by the host. */
export class TopicRunner {
  private readonly owner = randomUUID();
  private readonly topics: TopicManager;
  constructor(private readonly store: DmnStore, private readonly gateway: DmnGateway, private readonly runtime: RootRuntime,
    private readonly now: () => Date = () => new Date()) { this.topics = new TopicManager(store, now); }
  authorize(topicId: string, input: unknown) { assertSchedulingOwner(this.store.path); this.topics.authorize(topicId, input); }
  seed(topicId: string, nodeId: string) {
    assertSchedulingOwner(this.store.path);
    parseId(topicId); parseId(nodeId);
    this.store.transaction(() => {
      const topic = this.topics.row(topicId);
      if(this.store.one<{interaction_mode:string}>('SELECT interaction_mode FROM topics WHERE topic_id=?',topicId)?.interaction_mode==='direct')fail('FORBIDDEN','Direct chat requires an explicit user input.');
      if (!this.topics.policy(topicId)) fail('FORBIDDEN', 'Topic has no execution authorization.');
      if (!this.store.one('SELECT 1 FROM topic_participants WHERE topic_id=? AND node_id=?', topicId, nodeId)) fail('FORBIDDEN', 'Seed node is not a participant.');
      if (this.store.one('SELECT 1 FROM model_turns WHERE topic_id=? AND input_message_id IS NULL AND operator_message_id IS NULL', topicId)) return;
      if (!['active','waiting'].includes(topic.status) || topic.deadline_at <= this.now().toISOString()) fail('TOPIC_STOPPED', 'Topic cannot be started.');
      this.store.run("INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status,started_at,queue_created_at) VALUES(?,?,?,?,'queued',?,?)", randomUUID(),topicId,nodeId,this.node(nodeId).sessionId,this.now().toISOString(),this.now().toISOString());
      this.refreshNode(nodeId);
    });
  }
  async drain(shouldContinue:()=>boolean=()=>true) {
    assertSchedulingOwner(this.store.path);
    this.topics.expire();
    while (shouldContinue()) {
      const now = this.now().toISOString();
      const nodes = this.store.all<{ id: string }>(`SELECT node_id AS id FROM model_turns WHERE status='queued' AND (ready_at IS NULL OR ready_at<=?)
        UNION SELECT recipient_node AS id FROM deliveries WHERE status='queued' OR (status='retry' AND next_attempt_at<=?)
        UNION SELECT node_id AS id FROM node_locks WHERE state='running' AND lease_until<=?`, now,now,now);
      const progress = await Promise.all(nodes.map(n => this.tick(n.id)));
      if (!progress.some(Boolean)) return;
      this.topics.expire();
    }
  }
  /** Timer-based retry wakes, no idle model polling. Stops when no authorized retry remains. */
  async runUntilIdle() {
    while (true) {
      await this.drain();
      const due = this.store.one<{ wake: string }>(`SELECT min(wake) AS wake FROM (
        SELECT min(d.next_attempt_at,t.deadline_at) AS wake FROM deliveries d JOIN messages m ON m.message_id=d.message_id JOIN topics t ON t.topic_id=m.topic_id
        WHERE d.status='retry' AND t.status IN ('active','waiting')
        UNION ALL SELECT min(s.ready_at,t.deadline_at) FROM model_turns s JOIN topics t ON t.topic_id=s.topic_id WHERE s.status='queued' AND s.ready_at IS NOT NULL AND t.status IN ('active','waiting'))`);
      if (!due?.wake) return;
      const delay = Date.parse(due.wake)-this.now().getTime();
      if (delay <= 0) return; // A blocked/quarantined node needs explicit reconciliation, not a spin loop.
      await new Promise(resolve => setTimeout(resolve, Math.min(delay,60000)));
    }
  }
  async tick(nodeId: string): Promise<boolean> {
    assertSchedulingOwner(this.store.path);
    parseId(nodeId); const claim = this.claim(nodeId); if (!claim) return false;
    const { turn, input } = claim; let received = false; let confirmed = false;
    try {
      const raw = await this.runtime.run(input, id => {
        parseId(id); this.store.transaction(() => {
          this.owned(turn.turn_id);
          this.store.run('UPDATE model_turns SET sdk_receipt_id=? WHERE turn_id=?', id,turn.turn_id);
          if (turn.input_message_id) this.store.run("UPDATE deliveries SET status='delivered',sdk_receipt_id=?,updated_at=? WHERE message_id=?", id,this.now().toISOString(),turn.input_message_id);
        }); received = true;
      });
      const checked = resultSchema.safeParse(raw);
      if (!checked.success || checked.data.sessionId !== input.node.sessionId) fail('FORBIDDEN', 'Runtime result violates the bound session contract.');
      confirmed = true;
      // Independent checkpoint: a later business DB failure can be reconciled without another model call.
      this.store.transaction(() => {
        this.owned(turn.turn_id);
        this.store.run('INSERT INTO runtime_results(turn_id,node_id,result_json,created_at) VALUES(?,?,?,?)',turn.turn_id,nodeId,JSON.stringify(checked.data),this.now().toISOString());
      });
      this.apply(turn,checked.data,false);
    } catch (error) {
      this.store.transaction(() => {
        if (!this.isOwned(turn.turn_id)) return;
        if (confirmed && error instanceof DmnError && ['VALIDATION','FORBIDDEN'].includes(error.code)) this.failConfirmed(turn,'INVALID_OUTPUT');
        else if (!received && error instanceof RuntimeNotSubmittedError) this.retryOrDead(turn,error.retryable,'NOT_SUBMITTED');
        else this.unknown(turn,received ? 'RECEIPT_UNKNOWN' : 'OUTCOME_UNKNOWN');
      });
    }
    return true;
  }

  async reconcile(turnId: string, action: 'inspect' | 'drop' = 'inspect', audit?:{operator:'cli-user'|'desktop-user';reason:string}) {
    assertSchedulingOwner(this.store.path);
    if(!['inspect','drop'].includes(action))fail('VALIDATION','Unknown reconciliation action.');
    parseId(turnId);
    const turn = this.store.one<Turn>('SELECT * FROM model_turns WHERE turn_id=?',turnId);
    if (!turn) fail('NOT_FOUND','Turn does not exist.');
    if (turn.status !== 'unknown') return { state: turn.status, applied: false };
    if (!turn.input_snapshot_json) return { state: 'unknown', applied: false, reason: 'LEGACY_INPUT_UNAVAILABLE' };
    const input = JSON.parse(turn.input_snapshot_json) as RuntimeInput;
    if (input.node.id !== turn.node_id || input.turnId !== turnId || input.node.sessionId !== this.node(turn.node_id).sessionId) fail('FORBIDDEN','Stored execution binding is inconsistent.');
    const cached = this.store.one<{ result_json: string }>('SELECT result_json FROM runtime_results WHERE turn_id=? AND node_id=?',turnId,turn.node_id);
    const evidence: Inspection = cached ? { state:'completed',result:resultSchema.parse(JSON.parse(cached.result_json)),receiptId:turn.sdk_receipt_id ?? '' } :
      this.runtime.inspect ? await this.runtime.inspect(input,turn.sdk_receipt_id) : { state:'unknown',reason:'NO_INSPECTOR',quiescent:false };
    if (evidence.state === 'unknown' && (action !== 'drop' || !evidence.quiescent)) return { state:'unknown',applied:false,reason:evidence.reason };
    return this.store.transaction(() => {
      const current = this.store.one<Turn>('SELECT * FROM model_turns WHERE turn_id=?',turnId)!;
      if (current.status !== 'unknown') return { state:current.status,applied:false };
      if (!this.store.one("SELECT 1 FROM node_locks WHERE turn_id=? AND state='quarantined'",turnId)) fail('CONFLICT','Unknown turn is not quarantined.');
      this.store.run("UPDATE node_locks SET owner=?,state='running' WHERE turn_id=?",this.owner,turnId);
      const auditEvent=()=>{if(audit)this.store.run('INSERT INTO events(event_type,topic_id,node_id,payload_json,created_at) VALUES(?,?,?,?,?)',action==='drop'?'operator.turn_dropped':'operator.turn_reconciled',turn.topic_id,turn.node_id,JSON.stringify({turnId,operator:audit.operator,reason:audit.reason}),this.now().toISOString());};
      if (action === 'drop') { this.failConfirmed(current,'OPERATOR_DROP'); this.event('turn.dropped',turn.topic_id,turn.node_id);auditEvent(); return { state:'failed',applied:true }; }
      if (evidence.state !== 'completed') fail('CONFLICT','Completed evidence is required.');
      const result = resultSchema.parse(evidence.result);
      if (result.sessionId !== input.node.sessionId) fail('FORBIDDEN','Reconciled session identity mismatch.');
      if (evidence.receiptId) this.store.run('UPDATE model_turns SET sdk_receipt_id=? WHERE turn_id=?',evidence.receiptId,turnId);
      this.store.run('INSERT OR IGNORE INTO runtime_results VALUES(?,?,?,?)',turnId,turn.node_id,JSON.stringify(result),this.now().toISOString());
      try { this.apply(current,result,true); }
      catch (error) {
        if (error instanceof DmnError && ['VALIDATION','FORBIDDEN'].includes(error.code)) this.failConfirmed(current,'INVALID_RECONCILED_OUTPUT');
        else throw error;
      }
      this.event('turn.reconciled',turn.topic_id,turn.node_id);
      auditEvent();
      return { state:this.store.one<{ status:string }>('SELECT status FROM model_turns WHERE turn_id=?',turnId)!.status,applied:true };
    });
  }
  private claim(nodeId: string): { turn: Turn; input: RuntimeInput } | undefined {
    return this.store.transaction(() => {
      const now = this.now().toISOString();
      const lock = this.store.one<{ turn_id:string; state:string; lease_until:string }>('SELECT * FROM node_locks WHERE node_id=?',nodeId);
      if (lock) {
        if (lock.state === 'running' && lock.lease_until <= now) {
          const prior = this.store.one<Turn>('SELECT * FROM model_turns WHERE turn_id=?',lock.turn_id)!;
          this.unknown(prior,'LEASE_EXPIRED');
        }
        return;
      }
      const pending = this.store.all<{ topic_id:string; turn_id:string|null; message_id:string|null; sort_time:string; ready_at:string|null }>(`
        SELECT topic_id,turn_id,NULL AS message_id,COALESCE(queue_created_at,started_at) AS sort_time,ready_at,rowid AS queue_order,0 AS kind_order FROM model_turns WHERE node_id=? AND status='queued'
        UNION ALL SELECT m.topic_id,NULL,m.message_id,m.created_at,CASE WHEN d.status='retry' THEN d.next_attempt_at ELSE NULL END,m.rowid,1 FROM deliveries d JOIN messages m ON m.message_id=d.message_id
        WHERE d.recipient_node=? AND d.status IN ('queued','retry') ORDER BY sort_time,kind_order,queue_order`,nodeId,nodeId);
      for (const job of pending) {
        const topic = this.topics.row(job.topic_id); if (!['active','waiting'].includes(topic.status)) continue;
        if (!this.store.one('SELECT 1 FROM topic_participants WHERE topic_id=? AND node_id=?',job.topic_id,nodeId)) continue;
        const envelope = job.message_id ? this.store.one<Envelope>('SELECT m.*,d.attempts FROM messages m JOIN deliveries d ON d.message_id=m.message_id WHERE m.message_id=?',job.message_id)! : undefined;
        if (envelope?.expires_at && envelope.expires_at <= now) { this.store.run("UPDATE deliveries SET status='cancelled',last_error='EXPIRED' WHERE message_id=?",job.message_id!); this.topics.refresh(job.topic_id); continue; }
        if(job.ready_at&&job.ready_at>now){this.refreshNode(nodeId);return;}
        const limits = this.topics.reserve(job.topic_id,nodeId); if (!limits) continue;
        const node = this.node(nodeId);
        const old = job.turn_id ? this.store.one<Turn>('SELECT * FROM model_turns WHERE turn_id=?',job.turn_id)! : undefined;
        const operator = old?.operator_message_id ? this.store.one<{message_id:string;operator_id:string;content:string}>('SELECT * FROM operator_messages WHERE message_id=?',old.operator_message_id) : undefined;
        const number = old?.attempt_number ?? ((envelope?.attempts ?? 0)+1);
        const turnId = job.turn_id ?? randomUUID();
        const privateContext = new MemoryManager(this.store,this.now).forPrompt(nodeId,`${envelope?.content ?? operator?.content ?? ''} ${topic.title}`);
        const resume = !!this.store.one('SELECT 1 FROM model_turns WHERE node_id=? AND turn_id<>? AND sdk_receipt_id IS NOT NULL LIMIT 1',nodeId,turnId);
        const persona=this.store.one<{system_prompt:string|null;revision:number}>('SELECT system_prompt,revision FROM node_prompts WHERE node_id=?',nodeId);
        const input: RuntimeInput = { ...(persona?.system_prompt?{systemPrompt:persona.system_prompt,}:{}),systemPromptRevision:persona?.revision??0,node,topicId:job.topic_id,turnId,resume,limits,prompt:JSON.stringify({ dmnTurnId:turnId,nodeId,mode:this.store.one<{interaction_mode:string}>('SELECT interaction_mode FROM topics WHERE topic_id=?',job.topic_id)!.interaction_mode,identity:privateContext.identity,
          topic:{ id:topic.topic_id,title:topic.title,initialPrompt:topic.initial_prompt },privateMemories:privateContext.related,
          incoming:envelope ? { id:envelope.message_id,from:envelope.from_node,to:envelope.to_node,type:envelope.type,content:envelope.content } : operator ? {id:operator.message_id,from:operator.operator_id,to:nodeId,type:'operator',content:operator.content} : null,
          peers:this.store.all('SELECT node_id AS id FROM topic_participants WHERE topic_id=? AND node_id<>? ORDER BY node_id',job.topic_id,nodeId) }) };
        if (old) this.store.run("UPDATE model_turns SET status='running',started_at=?,topic_epoch=?,input_snapshot_json=? WHERE turn_id=?",now,topic.control_epoch,JSON.stringify(input),turnId);
        else this.store.run("INSERT INTO model_turns(turn_id,topic_id,node_id,input_message_id,sdk_session_id,status,started_at,attempt_number,topic_epoch,input_snapshot_json) VALUES(?,?,?,?,?,'running',?,?,?,?)",turnId,job.topic_id,nodeId,job.message_id,node.sessionId,now,number,topic.control_epoch,JSON.stringify(input));
        const turn = this.store.one<Turn>('SELECT * FROM model_turns WHERE turn_id=?',turnId)!;
        const lease = new Date(this.now().getTime()+limits.turnTimeoutMs+30000).toISOString();
        this.store.run("INSERT INTO node_locks VALUES(?,?,?,?,'running')",nodeId,turnId,this.owner,lease);
        this.store.run("INSERT INTO delivery_attempts(turn_id,job_key,attempt_number,outcome,started_at) VALUES(?,?,?,'running',?)",turnId,this.jobKey(turn),number,now);
        this.store.run("UPDATE model_nodes SET status='running' WHERE node_id=?",nodeId);
        if (job.message_id) this.store.run("UPDATE deliveries SET status='leased',attempts=attempts+1,lease_until=?,next_attempt_at=NULL,updated_at=? WHERE message_id=?",lease,now,job.message_id);
        this.event('turn.started',job.topic_id,nodeId); return { turn,input };
      }
      this.refreshNode(nodeId); return;
    });
  }
  private apply(turn: Turn, result: RuntimeResult, reconciled: boolean) {
    const parsed = decodeModelOutput(result.text);
    if (!parsed.success) {
      this.store.transaction(() => {
        this.owned(turn.turn_id);
        const event=`turn.output_${parsed.reason}`,payload=JSON.stringify({turnId:turn.turn_id});
        if (!this.store.one('SELECT 1 FROM events WHERE topic_id=? AND node_id=? AND event_type=? AND payload_json=?',turn.topic_id,turn.node_id,event,payload)) {
          this.store.run('INSERT INTO events(event_type,topic_id,node_id,payload_json,created_at) VALUES(?,?,?,?,?)',event,turn.topic_id,turn.node_id,payload,this.now().toISOString());
        }
      });
      fail('VALIDATION','Runtime did not return an authorized structured suggestion.');
    }
    this.store.transaction(() => {
      this.owned(turn.turn_id); const topic = this.topics.row(turn.topic_id); const output = parsed.data;
      this.store.run('UPDATE model_turns SET usage_json=?,event_offset=? WHERE turn_id=?',JSON.stringify(result.usage ?? {}),result.eventOffset ?? null,turn.turn_id);
      const authorized = topic.control_epoch === turn.topic_epoch && ['active','waiting'].includes(topic.status) && topic.deadline_at > this.now().toISOString();
      const mode=this.store.one<{interaction_mode:string}>('SELECT interaction_mode FROM topics WHERE topic_id=?',turn.topic_id)!.interaction_mode;
      if(output.action==='send' && mode==='direct')fail('FORBIDDEN','Direct chat cannot send messages to peers.');
      if(output.action==='reply_user' && !turn.operator_message_id)fail('FORBIDDEN','User reply requires an actual operator input.');
      this.store.run('UPDATE model_turns SET output_action=?,effects_suppressed=? WHERE turn_id=?',output.action,Number(!authorized),turn.turn_id);
      if(authorized && output.action==='reply_user'){
        const incoming=this.store.one<{operator_id:string;to_node:string;topic_id:string}>('SELECT * FROM operator_messages WHERE message_id=?',turn.operator_message_id!);
        if(!incoming || incoming.to_node!==turn.node_id || incoming.topic_id!==turn.topic_id)fail('FORBIDDEN','User reply input binding mismatch.');
        this.store.run('INSERT INTO user_replies VALUES(?,?,?,?,?,?,?,?)',randomUUID(),turn.topic_id,turn.node_id,incoming.operator_id,turn.operator_message_id!,turn.turn_id,output.content,this.now().toISOString());
      }
      if (authorized && topic.used_model_turns < topic.max_model_turns && output.action === 'send') this.gateway.bindNode(turn.node_id).send({ to:output.to,topicId:turn.topic_id,content:output.content,
        type:output.type ?? (turn.input_message_id ? 'reply' : 'question'),expectReply:true,idempotencyKey:`turn:${turn.turn_id}`,
        ...(turn.input_message_id ? { replyTo:turn.input_message_id } : {}) });
      this.finish(turn,'completed','handled',reconciled ? 'reconciled' : 'completed');
      if (authorized) new MemoryManager(this.store,this.now).acceptTurn(turn.node_id,turn.turn_id,output.memories);
      else this.event('turn.effects_suppressed',turn.topic_id,turn.node_id);
    });
  }
  private retryOrDead(turn: Turn, retryable: boolean, code: string) {
    const limits = this.topics.policy(turn.topic_id)!;
    const topic = this.topics.row(turn.topic_id);
    const allow = retryable && turn.attempt_number < limits.maxAttempts && topic.status !== 'closed';
    this.store.run("UPDATE model_turns SET status='failed',finished_at=? WHERE turn_id=?",this.now().toISOString(),turn.turn_id);
    this.store.run("UPDATE delivery_attempts SET outcome='failed',error_code=?,finished_at=? WHERE turn_id=?",code,this.now().toISOString(),turn.turn_id);
    this.store.run('DELETE FROM node_locks WHERE turn_id=? AND owner=?',turn.turn_id,this.owner);
    if (allow) {
      const delay = limits.backoffSeconds[Math.min(turn.attempt_number-1,limits.backoffSeconds.length-1)]!;
      const due = new Date(this.now().getTime()+delay*1000).toISOString();
      if (turn.input_message_id) this.store.run("UPDATE deliveries SET status='retry',next_attempt_at=?,lease_until=NULL,last_error=?,updated_at=? WHERE message_id=?",due,code,this.now().toISOString(),turn.input_message_id);
      else {
        const origin=turn.retry_of ?? turn.turn_id;
        const queued=this.store.one<{stamp:string}>('SELECT COALESCE(queue_created_at,started_at) AS stamp FROM model_turns WHERE turn_id=?',origin)!.stamp;
        this.store.run("INSERT INTO model_turns(turn_id,topic_id,node_id,sdk_session_id,status,attempt_number,retry_of,ready_at,started_at,queue_created_at,operator_message_id) VALUES(?,?,?,?,'queued',?,?,?,?,?,?)",randomUUID(),turn.topic_id,turn.node_id,this.node(turn.node_id).sessionId,turn.attempt_number+1,origin,due,this.now().toISOString(),queued,turn.operator_message_id);
      }
      this.event('turn.retry_scheduled',turn.topic_id,turn.node_id);
    } else this.deadLetter(turn,code);
    this.refreshNode(turn.node_id); this.topics.refresh(turn.topic_id);
  }
  private failConfirmed(turn: Turn, code: string) {
    this.deadLetter(turn,code); this.finish(turn,'failed','dead_letter',code==='OPERATOR_DROP'?'dropped':'failed',code);
  }
  private deadLetter(turn: Turn, code: string) {
    if (turn.input_message_id) this.store.run("UPDATE deliveries SET status='dead_letter',lease_until=NULL,next_attempt_at=NULL,last_error=? WHERE message_id=?",code,turn.input_message_id);
    this.store.run('INSERT OR IGNORE INTO dead_letters VALUES(?,?,?,?,?,?,?)',this.jobKey(turn),turn.turn_id,turn.topic_id,turn.node_id,turn.input_message_id,code,this.now().toISOString());
    this.event('turn.dead_letter',turn.topic_id,turn.node_id);
  }
  private unknown(turn: Turn, code: string) {
    this.store.run("UPDATE model_turns SET status='unknown',finished_at=? WHERE turn_id=?",this.now().toISOString(),turn.turn_id);
    if (turn.input_message_id) this.store.run("UPDATE deliveries SET status='unknown',last_error='RECONCILE_REQUIRED',updated_at=? WHERE message_id=?",this.now().toISOString(),turn.input_message_id);
    this.store.run("UPDATE delivery_attempts SET outcome='unknown',error_code=?,finished_at=? WHERE turn_id=?",code,this.now().toISOString(),turn.turn_id);
    this.store.run("UPDATE node_locks SET state='quarantined' WHERE turn_id=?",turn.turn_id);
    this.store.run("UPDATE model_nodes SET status='cooling' WHERE node_id=?",turn.node_id); this.event('turn.unknown',turn.topic_id,turn.node_id);
  }
  private finish(turn: Turn, status: 'completed'|'failed', delivery: 'handled'|'dead_letter', outcome: string, code?: string) {
    this.store.run('UPDATE model_turns SET status=?,finished_at=? WHERE turn_id=?',status,this.now().toISOString(),turn.turn_id);
    if (turn.input_message_id) this.store.run('UPDATE deliveries SET status=?,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE message_id=?',delivery,this.now().toISOString(),turn.input_message_id);
    this.store.run('UPDATE delivery_attempts SET outcome=?,error_code=?,finished_at=? WHERE turn_id=?',outcome,code ?? null,this.now().toISOString(),turn.turn_id);
    this.store.run('DELETE FROM node_locks WHERE turn_id=? AND owner=?',turn.turn_id,this.owner);
    this.refreshNode(turn.node_id); this.topics.refresh(turn.topic_id); this.event(`turn.${status}`,turn.topic_id,turn.node_id);
  }
  private refreshNode(nodeId: string) {
    refreshNodeState(this.store,nodeId,this.now().toISOString());
  }
  private jobKey(turn: Turn) { return turn.input_message_id ? `message:${turn.input_message_id}` : `seed:${turn.retry_of ?? turn.turn_id}`; }
  private isOwned(turnId: string) { return !!this.store.one("SELECT 1 FROM node_locks WHERE turn_id=? AND owner=? AND state='running'",turnId,this.owner); }
  private owned(turnId: string) { if (!this.isOwned(turnId)) fail('CONFLICT','Turn no longer owns the node lock.'); }
  private node(id: string): ModelNode {
    const row = this.store.one<{ node_id:string; provider:string; model_id:string; session_id:string; persona_ref:string; memory_namespace:string; allowed_tools_json:string }>('SELECT * FROM model_nodes WHERE node_id=?',id);
    if (!row) fail('NOT_FOUND','Node does not exist.');
    return { id:row.node_id,provider:row.provider,model:row.model_id,sessionId:row.session_id,personaRef:row.persona_ref,memoryNamespace:row.memory_namespace,allowedTools:JSON.parse(row.allowed_tools_json) };
  }
  private event(type: string, topicId: string, nodeId: string) { this.store.run('INSERT INTO events(event_type,topic_id,node_id,created_at) VALUES(?,?,?,?)',type,topicId,nodeId,this.now().toISOString()); }
}
