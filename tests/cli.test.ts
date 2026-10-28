import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureNodes, policy } from './fixtures.ts';
import {DatabaseSync} from 'node:sqlite';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function run(...args: string[]) { return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' }); }

test('CLI init/status is repeatable; status does not create a missing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-cli-'));
  const path = join(dir, 'nested', 'queue.sqlite');
  try {
    assert.equal(run('status', path).status, 1);
    assert.equal(existsSync(path), false);
    for (let i = 0; i < 2; i++) {
      const result = run('init', path);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).schemaVersion, 8);
    }
    const result = run('status', path);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).counts, { nodes: 0, topics: 0, messages: 0, queuedDeliveries: 0 });
    assert.equal(run('unrecognized').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI validates YAML without executing models and omits supplied secrets from errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-config-'));
  try {
    const nodesPath = join(dir, 'nodes.yaml');
    const policyPath = join(dir, 'policy.yaml');
    writeFileSync(nodesPath, JSON.stringify({ nodes: fixtureNodes }));
    writeFileSync(policyPath, JSON.stringify(policy));
    const valid = run('validate', nodesPath, policyPath);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { valid: true, nodeCount: 3, executionEnabled: false });
    writeFileSync(nodesPath, JSON.stringify({ nodes: fixtureNodes, apiKey: 'never-print-this-secret' }));
    const invalid = run('validate', nodesPath, policyPath);
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /never-print-this-secret/);
    assert.equal(JSON.parse(invalid.stderr.split('\n').find(line => line.startsWith('{'))!).code, 'VALIDATION');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P5 CLI exposes stopped backup and readonly metrics without implicit migration or model calls',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-cli-p5-')),database=join(dir,'db.sqlite'),bundle=join(dir,'backup');
 try{
  assert.equal(run('init',database).status,0);
  const metrics=run('metrics',database);assert.equal(metrics.status,0,metrics.stderr);assert.equal(JSON.parse(metrics.stdout).tokens.withUsage,0);
  const created=run('backup',database,bundle);assert.equal(created.status,0,created.stderr);assert.equal(JSON.parse(created.stdout).created,true);
  const verified=run('backup-verify',bundle);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).verified,true);
  assert.equal(run('restore',bundle,database).status,1);assert.equal(run('reconcile',database,'missing','drop').status,1);
  const db=new DatabaseSync(database);db.exec('PRAGMA user_version=6');db.close();assert.equal(run('metrics',database).status,1);
  const check=new DatabaseSync(database,{readOnly:true});try{assert.equal((check.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,6);}finally{check.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
