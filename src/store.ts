import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fail, storageError } from './errors.ts';
import { contentKey } from './memory-contracts.ts';
import { parseExecution } from './execution-contracts.ts';
import {registerClient,databasePath} from './maintenance.ts';

/** Trusted storage boundary only: never pass this object to a node or model tool. */
export class DmnStore {
  private db!: DatabaseSync;
  private readonly releaseClient:()=>void;
  private closed = false;
  private depth = 0;
  readonly path:string;
  get runtimeRoot(){if(this.path===':memory:')fail('FORBIDDEN','In-memory databases cannot own SDK history.');return this.path+'.runtime';}

  constructor(path: string, options:{readOnly?:boolean}={}) {
    this.path=path===':memory:'?path:databasePath(path);
    this.releaseClient=registerClient(this.path);
    try {
      this.db = new DatabaseSync(this.path,options);
      if(options.readOnly){
        this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        if(this.one<{user_version:number}>('PRAGMA user_version')!.user_version!==8)fail('STORAGE','Read-only access requires an explicit supported migration.');
        return;
      }
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.transaction(() => {
        const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
        if (version > 8 || version < 0) fail('STORAGE', 'Unsupported database schema version.');
        // Pre-v5 activities have no exact host input snapshot. Do not invent one or
        // let new scheduling resume a node whose prior activity cannot be proved.
        const legacy=version>0&&version<5?this.all<{turn_id:string;node_id:string;topic_id:string;input_message_id:string|null}>("SELECT turn_id,node_id,topic_id,input_message_id FROM model_turns WHERE status IN ('running','unknown')"):[];
        if(new Set(legacy.map(t=>t.node_id)).size!==legacy.length)fail('STORAGE','Multiple unresolved legacy turns require manual migration review.');
        const migrationTime=new Date().toISOString();
        for(const turn of legacy){
          this.run("UPDATE model_turns SET status='unknown',finished_at=COALESCE(finished_at,?) WHERE turn_id=?",migrationTime,turn.turn_id);
          this.run("UPDATE model_nodes SET status='cooling' WHERE node_id=?",turn.node_id);
          if(turn.input_message_id)this.run("UPDATE deliveries SET status='unknown',last_error='LEGACY_INPUT_UNAVAILABLE',updated_at=? WHERE message_id=?",migrationTime,turn.input_message_id);
        }
        if (version === 0) {
          const existing = this.one<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")!;
          if (existing.n) fail('STORAGE', 'Unversioned non-empty database requires manual migration.');
          const sql = readFileSync(new URL('../sql/001_init.sql', import.meta.url), 'utf8').replace(/^PRAGMA .*;\r?$/gm, '');
          this.db.exec(sql);
        }
        if (version < 2) {
          this.db.exec(readFileSync(new URL('../sql/002_node_capabilities.sql', import.meta.url), 'utf8'));
          this.db.exec('PRAGMA user_version = 2;');
        }
        if (version < 3) {
          this.db.exec(readFileSync(new URL('../sql/003_runtime.sql', import.meta.url), 'utf8'));
          this.db.exec('PRAGMA user_version = 3;');
        }
        if (version < 4) {
          this.db.exec(readFileSync(new URL('../sql/004_memory.sql', import.meta.url), 'utf8'));
          for (const row of this.all<{ memory_id: string; content: string }>('SELECT memory_id,content FROM memories')) {
            this.run('UPDATE memories SET content_key=? WHERE memory_id=?', contentKey(row.content), row.memory_id);
          }
          this.db.exec('PRAGMA user_version = 4;');
        }
        if (version < 5) {
          this.db.exec(readFileSync(new URL('../sql/005_policy_recovery.sql', import.meta.url), 'utf8'));
          for(const row of this.all<{topic_id:string;limits_json:string}>('SELECT topic_id,limits_json FROM topic_execution')){
            this.run('UPDATE topic_execution SET limits_json=? WHERE topic_id=?',JSON.stringify(parseExecution(JSON.parse(row.limits_json))),row.topic_id);
          }
          this.db.exec('PRAGMA user_version = 5;');
        }
        if (version < 6) {
          this.db.exec(readFileSync(new URL('../sql/006_desktop_operator.sql', import.meta.url), 'utf8'));
          this.db.exec('PRAGMA user_version = 6;');
        }
        if (version < 7) {
          this.db.exec(readFileSync(new URL('../sql/007_user_replies.sql', import.meta.url), 'utf8'));
          this.db.exec('PRAGMA user_version = 7;');
        }
        if (version < 8) {
          this.db.exec(readFileSync(new URL('../sql/008_node_prompts.sql', import.meta.url), 'utf8'));
          this.db.exec('PRAGMA user_version = 8;');
        }
        for(const turn of legacy){
          const lock=this.one<{turn_id:string}>('SELECT turn_id FROM node_locks WHERE node_id=?',turn.node_id);
          if(lock&&lock.turn_id!==turn.turn_id)fail('STORAGE','Legacy lock binding requires manual migration review.');
          if(lock)this.run("UPDATE node_locks SET state='quarantined' WHERE node_id=?",turn.node_id);
          else this.run("INSERT INTO node_locks VALUES(?,?,?,?,'quarantined')",turn.node_id,turn.turn_id,'legacy-migration',migrationTime);
          this.run("INSERT INTO events(event_type,topic_id,node_id,payload_json,created_at) VALUES('turn.legacy_quarantined',?,?,?,?)",turn.topic_id,turn.node_id,JSON.stringify({turnId:turn.turn_id,fromSchema:version,reason:'LEGACY_INPUT_UNAVAILABLE'}),migrationTime);
        }
      });
    } catch (error) { this.db?.close(); this.releaseClient(); storageError(error); }
  }

  transaction<T>(operation: () => T): T {
    return this.withTransaction(operation,'BEGIN IMMEDIATE');
  }
  readSnapshot<T>(operation:()=>T):T{return this.withTransaction(operation,'BEGIN');}
  private withTransaction<T>(operation:()=>T,begin:string):T{
    const savepoint = this.depth ? `dmn_nested_${this.depth}` : undefined;
    try { this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : begin); }
    catch (error) { storageError(error); }
    this.depth++;
    try {
      const value = operation();
      if (value && typeof (value as { then?: unknown }).then === 'function') fail('STORAGE', 'Database transactions must be synchronous.');
      this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
        if (savepoint) this.db.exec(`RELEASE ${savepoint}`);
      } catch { /* Preserve the original sanitized error. */ }
      storageError(error);
    } finally { this.depth--; }
  }
  run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
  one<T>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as T | undefined; }
  all<T>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  iterate<T>(sql:string,...values:SQLInputValue[]){return this.db.prepare(sql).iterate(...values) as IterableIterator<T>;}
  close() { if (!this.closed) { this.db.close(); this.releaseClient(); this.closed = true; } }
}
