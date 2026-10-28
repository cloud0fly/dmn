import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DmnStore } from '../src/store.ts';
import { DmnGateway } from '../src/gateway.ts';
import { setup } from './fixtures.ts';

test('E01: committed queue survives child-process loss without orderly close', () => {
  const f = setup();
  try {
    f.store.close();
    const worker = fileURLToPath(new URL('./helpers/commit-and-exit.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', worker, f.path, f.topic.id], { encoding: 'utf8' });
    assert.equal(result.status, 23, result.stderr);
    const recovered = new DmnStore(f.path);
    try {
      const inbox = new DmnGateway(recovered, () => new Date('2026-10-26T00:00:02Z')).bindNode('b').getInbox();
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0]?.content, 'durable before abrupt exit');
    } finally { recovered.close(); }
  } finally { f.cleanup(); }
});

test('schema v1 upgrades atomically to v8 and migration reapplication preserves nodes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-migration-'));
  const path = join(dir, 'legacy.sqlite');
  try {
    const sql = new DatabaseSync(path);
    sql.exec(readFileSync(new URL('../sql/001_init.sql', import.meta.url), 'utf8'));
    sql.exec("INSERT INTO model_nodes (node_id,provider,model_id,session_id,persona_ref,memory_namespace) VALUES ('legacy','test','test','legacy-root','persona.md','memory:legacy'); PRAGMA user_version=1;");
    sql.close();
    for (let i = 0; i < 2; i++) {
      const store = new DmnStore(path);
      try {
        assert.equal(store.one<{ user_version: number }>('PRAGMA user_version')?.user_version, 8);
        assert.equal(store.one<{ tools: string }>('SELECT allowed_tools_json AS tools FROM model_nodes WHERE node_id=?', 'legacy')?.tools, '[]');
        assert.throws(() => new DmnGateway(store).bindNode('legacy').getInbox(), { code: 'FORBIDDEN' });
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown future and unversioned nonempty databases fail closed without destructive migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-foreign-db-'));
  const path = join(dir, 'foreign.sqlite');
  try {
    const sql = new DatabaseSync(path);
    sql.exec('CREATE TABLE unrelated (id INTEGER); INSERT INTO unrelated VALUES (42)');
    sql.close();
    assert.throws(() => new DmnStore(path), { code: 'STORAGE' });
    const future = new DatabaseSync(path);
    future.exec('PRAGMA user_version=99');
    future.close();
    assert.throws(() => new DmnStore(path), { code: 'STORAGE' });
    const verify = new DatabaseSync(path);
    try { assert.equal((verify.prepare('SELECT id FROM unrelated').get() as { id: number }).id, 42); }
    finally { verify.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
