import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DmnStore } from '../src/store.ts';
import { MemoryManager } from '../src/memory.ts';

test('P1 migration preserves v3 memory rows, normalizes dedup keys, rebuilds Chinese FTS and remains repeatable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-memory-migration-'));
  const path = join(dir, 'v3.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    for (const file of ['001_init.sql','002_node_capabilities.sql','003_runtime.sql']) legacy.exec(readFileSync(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
    legacy.exec("INSERT INTO model_nodes(node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES('a','p','m','s','persona.md','memory:a');");
    legacy.prepare("INSERT INTO memories(memory_id,owner_node_id,kind,content,subjective,source_message_ids_json) VALUES('legacy','a','episodic',?,0,'[]')").run('旧的持久化队列记忆保留。ROLLBACK');
    legacy.exec("INSERT INTO memory_revisions(revision_id,memory_id,prior_content,new_content,reason) VALUES('old-revision','legacy','旧观点','旧的持久化队列记忆保留。ROLLBACK','旧人工修订');");
    legacy.exec('PRAGMA user_version=3'); legacy.close();
    for (let n = 0; n < 2; n++) {
      const store = new DmnStore(path);
      try {
        assert.equal(store.one<{ user_version: number }>('PRAGMA user_version')?.user_version, 8);
        const api = new MemoryManager(store).bindNode('a');
        assert.equal(api.search({ query: '持久化队列' })[0]?.id, 'legacy');
        assert.equal(api.search({ query: 'rollback' })[0]?.id, 'legacy');
        assert.equal(api.get('legacy').version, 1);
        assert.equal(api.history('legacy')[0]?.prior.content, '旧观点');
        assert.equal(api.history('legacy')[0]?.legacySnapshot, true);
        assert.equal(api.get('legacy').evidenceStatus, 'legacy-unreviewed');
        assert.equal(new MemoryManager(store).forPrompt('a', '持久化队列').related.length, 0);
        assert.match(store.one<{ content_key: string }>('SELECT content_key FROM memories')!.content_key, /rollback/);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
