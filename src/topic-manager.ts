import { parseId } from './contracts.ts';
import { parseExecution, type ExecutionPolicy } from './execution-contracts.ts';
import { fail } from './errors.ts';
import { DmnStore } from './store.ts';
import { refreshNodeState } from './node-state.ts';
export type TopicRow = { topic_id: string; title: string; initial_prompt: string; status: string; deadline_at: string;
  max_model_turns: number; max_turns_per_node: number; used_model_turns: number; control_epoch: number; pause_reason: string | null };
export class TopicManager {
  constructor(private readonly store: DmnStore, private readonly now: () => Date = () => new Date()) {}
  get(topicId: string) {
    const topic = this.row(topicId);
    const outcomes = { queued:0, running:0, completed:0, failed:0, unknown:0 };
    for (const row of this.store.all<{status:keyof typeof outcomes;n:number}>('SELECT status,count(*) n FROM model_turns WHERE topic_id=? GROUP BY status',topicId)) outcomes[row.status]=row.n;
    const count = (sql:string) => this.store.one<{n:number}>(sql,topicId)!.n;
    return { id: topic.topic_id, state: topic.status, pauseReason: topic.pause_reason, epoch: topic.control_epoch,
      usedTurns: topic.used_model_turns, maxTurns: topic.max_model_turns, deadlineAt: topic.deadline_at,
      outcomes,pendingMessages:count("SELECT count(*) n FROM deliveries d JOIN messages m ON m.message_id=d.message_id WHERE m.topic_id=? AND d.status IN ('queued','retry')"),latestActivity:this.store.one<{nodeId:string;state:string;action:string|null;suppressed:number}>('SELECT node_id AS nodeId,status AS state,output_action AS action,effects_suppressed AS suppressed FROM model_turns WHERE topic_id=? ORDER BY rowid DESC LIMIT 1',topicId)??null,deadLetters:count('SELECT count(*) n FROM dead_letters WHERE topic_id=?'),
      outputErrors:{invalidJson:count("SELECT count(*) n FROM events WHERE topic_id=? AND event_type='turn.output_invalid_json'"),
        invalidEnvelope:count("SELECT count(*) n FROM events WHERE topic_id=? AND event_type='turn.output_invalid_envelope'")},
      nodes: this.store.all('SELECT node_id,max_turns,used_turns,max_input_tokens,reserved_input_tokens,max_output_tokens,reserved_output_tokens,max_cost,reserved_cost,deadline_at FROM node_budgets WHERE topic_id=? ORDER BY node_id', topicId) };
  }
  row(topicId: string): TopicRow {
    parseId(topicId); const topic = this.store.one<TopicRow>('SELECT * FROM topics WHERE topic_id=?', topicId);
    if (!topic) fail('NOT_FOUND', 'Topic does not exist.'); return topic;
  }
  authorize(topicId: string, input: unknown) {
    const config = parseExecution(input);
    this.store.transaction(() => {
      const topic = this.row(topicId);
      const members = this.store.all<{ node_id: string }>('SELECT node_id FROM topic_participants WHERE topic_id=?', topicId);
      for (const id of Object.keys(config.nodeLimits)) if (!members.some(n => n.node_id === id)) fail('FORBIDDEN', 'Quota owner is not a topic participant.');
      const prior = this.store.one<{ limits_json: string }>('SELECT limits_json FROM topic_execution WHERE topic_id=?', topicId);
      if (prior && JSON.stringify(parseExecution(JSON.parse(prior.limits_json))) !== JSON.stringify(config)) fail('CONFLICT', 'Execution authorization cannot change implicitly.');
      if (!prior) {
        this.store.run('INSERT INTO topic_execution(topic_id,limits_json) VALUES(?,?)', topicId, JSON.stringify(config));
        this.event('topic.authorized', topicId);
      }
      for (const node of members) this.ensureNodeBudget(topic, node.node_id, config);
    });
  }
  policy(topicId: string): ExecutionPolicy | undefined {
    const row = this.store.one<{ limits_json: string }>('SELECT limits_json FROM topic_execution WHERE topic_id=?', topicId);
    return row ? parseExecution(JSON.parse(row.limits_json)) : undefined;
  }
  private ensureNodeBudget(topic: TopicRow, nodeId: string, policy: ExecutionPolicy) {
    const custom = policy.nodeLimits[nodeId] ?? {};
    const deadline = custom.deadlineAt ? new Date(custom.deadlineAt).toISOString() : topic.deadline_at;
    if (deadline > topic.deadline_at || (custom.maxTurns ?? 0) > topic.max_turns_per_node ||
      (custom.maxInputTokens ?? 0) > policy.maxInputTokens || (custom.maxOutputTokens ?? 0) > policy.maxOutputTokens || (custom.maxEstimatedCost ?? 0) > policy.maxEstimatedCost) fail('VALIDATION', 'Node quota cannot exceed topic authorization.');
    const used = this.store.one<{ n: number }>("SELECT count(*) AS n FROM model_turns WHERE topic_id=? AND node_id=? AND status<>'queued'", topic.topic_id, nodeId)!.n;
    this.store.run(`INSERT OR IGNORE INTO node_budgets(topic_id,node_id,max_turns,max_input_tokens,max_output_tokens,max_cost,deadline_at,used_turns,reserved_input_tokens,reserved_output_tokens,reserved_cost)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, topic.topic_id, nodeId, custom.maxTurns ?? topic.max_turns_per_node,
      custom.maxInputTokens ?? policy.maxInputTokens, custom.maxOutputTokens ?? policy.maxOutputTokens, custom.maxEstimatedCost ?? policy.maxEstimatedCost,
      deadline, used, used*policy.inputTokensPerTurn, used*policy.outputTokensPerTurn, used*policy.estimatedCostPerTurn);
  }
  /** Called inside the scheduler claim transaction, including migrated authorizations. */
  reserve(topicId: string, nodeId: string): ExecutionPolicy | undefined {
    return this.store.transaction(()=>this.reserveLocked(topicId,nodeId));
  }
  private reserveLocked(topicId:string,nodeId:string):ExecutionPolicy|undefined{
    const topic = this.row(topicId); const policy = this.policy(topicId);
    if (!policy || !['active','waiting'].includes(topic.status)) return;
    if(!this.store.one('SELECT 1 FROM topic_participants WHERE topic_id=? AND node_id=?',topicId,nodeId))fail('FORBIDDEN','Budget owner is not a participant.');
    this.ensureNodeBudget(topic, nodeId, policy);
    const reason = this.stopReason(topic, nodeId, policy);
    if (reason) { this.stopBudget(topicId, reason); return; }
    this.store.run("UPDATE topics SET used_model_turns=used_model_turns+1,status='active',pause_reason=NULL WHERE topic_id=?", topicId);
    this.store.run('UPDATE topic_execution SET reserved_input_tokens=reserved_input_tokens+?,reserved_output_tokens=reserved_output_tokens+?,reserved_cost=reserved_cost+? WHERE topic_id=?', policy.inputTokensPerTurn, policy.outputTokensPerTurn, policy.estimatedCostPerTurn, topicId);
    this.store.run('UPDATE node_budgets SET used_turns=used_turns+1,reserved_input_tokens=reserved_input_tokens+?,reserved_output_tokens=reserved_output_tokens+?,reserved_cost=reserved_cost+? WHERE topic_id=? AND node_id=?', policy.inputTokensPerTurn, policy.outputTokensPerTurn, policy.estimatedCostPerTurn, topicId, nodeId);
    return policy;
  }
  private stopReason(topic: TopicRow, nodeId: string, policy: ExecutionPolicy): string | undefined {
    const n = this.store.one<{ used_turns: number; max_turns: number; max_input_tokens: number; max_output_tokens: number; max_cost: number; deadline_at: string;
      reserved_input_tokens: number; reserved_output_tokens: number; reserved_cost: number }>('SELECT * FROM node_budgets WHERE topic_id=? AND node_id=?', topic.topic_id, nodeId)!;
    const t = this.store.one<{ reserved_input_tokens: number; reserved_output_tokens: number; reserved_cost: number }>('SELECT * FROM topic_execution WHERE topic_id=?', topic.topic_id)!;
    const now = this.now().toISOString();
    if (topic.deadline_at <= now || n.deadline_at <= now) return 'DEADLINE';
    if (topic.used_model_turns >= topic.max_model_turns) return 'TOTAL_TURNS';
    if (n.used_turns >= n.max_turns) return 'NODE_TURNS';
    if (t.reserved_input_tokens+policy.inputTokensPerTurn > policy.maxInputTokens || n.reserved_input_tokens+policy.inputTokensPerTurn > n.max_input_tokens) return 'INPUT_BUDGET';
    if (t.reserved_output_tokens+policy.outputTokensPerTurn > policy.maxOutputTokens || n.reserved_output_tokens+policy.outputTokensPerTurn > n.max_output_tokens) return 'OUTPUT_BUDGET';
    if (t.reserved_cost+policy.estimatedCostPerTurn > policy.maxEstimatedCost+1e-10 || n.reserved_cost+policy.estimatedCostPerTurn > n.max_cost+1e-10) return 'COST_BUDGET';
  }
  pause(topicId: string) {
    this.store.transaction(() => {
      const t = this.row(topicId); if (t.status === 'closed') fail('TOPIC_STOPPED', 'Closed topics cannot be paused.');
      if (t.status === 'paused') return;
      this.store.run("UPDATE topics SET status='paused',pause_reason='MANUAL',control_epoch=control_epoch+1 WHERE topic_id=?", topicId); this.event('topic.paused', topicId);
      this.refreshNodes(topicId);
    });
  }
  resume(topicId: string) {
    this.store.transaction(() => {
      const t = this.row(topicId); if (t.status === 'closed') fail('TOPIC_STOPPED', 'Closed topics cannot be resumed.');
      if (t.deadline_at <= this.now().toISOString()) fail('TOPIC_STOPPED', 'Expired authorization cannot be extended by resume.');
      if (t.status !== 'paused') return;
      const policy = this.policy(topicId); if (!policy) fail('FORBIDDEN', 'Topic has no execution authorization.');
      const nodes = this.store.all<{ node_id: string }>('SELECT node_id FROM topic_participants WHERE topic_id=?', topicId);
      for (const n of nodes) { this.ensureNodeBudget(t,n.node_id,policy); if (this.stopReason(t,n.node_id,policy)) fail('BUDGET_EXHAUSTED', 'Resume cannot reset or exceed the remaining budget.'); }
      this.store.run("UPDATE topics SET status='active',pause_reason=NULL,control_epoch=control_epoch+1 WHERE topic_id=?", topicId); this.event('topic.resumed', topicId); this.refresh(topicId);
      this.refreshNodes(topicId);
    });
  }
  close(topicId: string) {
    this.store.transaction(() => {
      if (this.row(topicId).status === 'closed') return;
      this.store.run("UPDATE topics SET status='closed',closed_at=?,pause_reason=NULL,control_epoch=control_epoch+1 WHERE topic_id=?", this.now().toISOString(), topicId);
      this.store.run("UPDATE deliveries SET status='cancelled',lease_until=NULL,next_attempt_at=NULL WHERE status IN ('queued','retry') AND message_id IN (SELECT message_id FROM messages WHERE topic_id=?)", topicId);
      this.store.run("UPDATE model_turns SET status='failed',finished_at=? WHERE topic_id=? AND status='queued'", this.now().toISOString(), topicId);
      this.event('topic.closed', topicId);
      this.refreshNodes(topicId);
    });
  }
  expire() {
    this.store.transaction(() => {
      for (const t of this.store.all<{ topic_id: string }>("SELECT topic_id FROM topics WHERE status IN ('active','waiting') AND deadline_at<=?", this.now().toISOString())) this.stopBudget(t.topic_id, 'DEADLINE');
    });
  }
  stopBudget(topicId: string, reason: string) {
    this.store.run("UPDATE topics SET status='paused',pause_reason=? WHERE topic_id=? AND status IN ('active','waiting')", reason, topicId);
    this.event('topic.budget_stopped', topicId);
    this.refreshNodes(topicId);
  }
  refresh(topicId: string) {
    const t = this.row(topicId); if (!['active','waiting'].includes(t.status)) return;
    if (t.used_model_turns >= t.max_model_turns) { this.stopBudget(topicId, 'TOTAL_TURNS'); return; }
    const pending = this.store.one(`SELECT 1 FROM deliveries d JOIN messages m ON m.message_id=d.message_id WHERE m.topic_id=? AND d.status IN ('queued','retry','leased','delivered','unknown')
      UNION ALL SELECT 1 FROM model_turns WHERE topic_id=? AND status IN ('queued','running','unknown') LIMIT 1`, topicId, topicId);
    this.store.run("UPDATE topics SET status=? WHERE topic_id=? AND status IN ('active','waiting')", pending ? 'active' : 'waiting', topicId);
  }
  private event(type: string, topicId: string) {
    this.store.run('INSERT INTO events(event_type,topic_id,created_at) VALUES(?,?,?)', type, topicId, this.now().toISOString());
  }
  private refreshNodes(topicId:string){
    for(const node of this.store.all<{node_id:string}>('SELECT node_id FROM topic_participants WHERE topic_id=?',topicId))refreshNodeState(this.store,node.node_id,this.now().toISOString());
  }
}
