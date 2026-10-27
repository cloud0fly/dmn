import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import {
  DEFAULT_PATCH_HEADER,
  buildMcpEntry,
  hasMcpEntry,
  readPatchFile,
  resolveProfileDir,
  toPosixPath,
  upsertMcpEntry
} from '../scripts/mcp-patch.ts';

const options = { root: 'D:/work/dmn', command: 'C:/Program Files/nodejs/node.exe' };
const parse = (text: string) => YAML.parse(text, { logLevel: 'silent' } as never) as Record<string, never>[];

test('resolveProfileDir prefers DSH_PROFILE_DIR', () => {
  assert.deepEqual(resolveProfileDir({ DSH_PROFILE_DIR: 'C:/custom/profile' }), { dir: 'C:/custom/profile', source: 'DSH_PROFILE_DIR' });
});

test('resolveProfileDir honours DSH_HOME and DSH_PROFILE', () => {
  const resolved = resolveProfileDir({ DSH_HOME: 'C:/dsh-home', DSH_PROFILE: 'web' });
  assert.equal(resolved.dir, join('C:/dsh-home', 'profiles', 'web'));
  assert.equal(resolved.source, 'DSH_HOME');
});

test('resolveProfileDir defaults to <home>/.dsh/profiles/desktop', () => {
  const resolved = resolveProfileDir({});
  assert.match(toPosixPath(resolved.dir), /\/\.dsh\/profiles\/desktop$/);
  assert.equal(resolved.source, 'homedir');
});

test('readPatchFile starts from the shipped header for a missing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dmn-patch-'));
  try {
    const missing = readPatchFile(join(directory, 'cordis.patch.yml'));
    assert.equal(missing.existed, false);
    assert.equal(missing.text, DEFAULT_PATCH_HEADER);
    const blank = join(directory, 'blank.yml');
    writeFileSync(blank, '   \n', 'utf8');
    assert.equal(readPatchFile(blank).text, DEFAULT_PATCH_HEADER);
    const commented = join(directory, 'commented.yml');
    writeFileSync(commented, '# keep me\n', 'utf8');
    const read = readPatchFile(commented);
    assert.equal(read.existed, true);
    assert.equal(read.text, readFileSync(commented, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upsertMcpEntry adds a complete entry to an empty document', () => {
  const { text, changed } = upsertMcpEntry('', options);
  assert.equal(changed, true);
  assert.match(text, /!!js process\.env\.DEEPSEEK_API_KEY/);
  const document = parse(text);
  assert.equal(document.length, 1);
  const entry = document[0] as unknown as { insert: { id: string; config: { command: string; cwd: string; args: string[]; env: Record<string, string> } }[] };
  assert.equal(entry.insert[0]!.id, 'mcp-dmn');
  assert.equal(entry.insert[0]!.config.command, 'C:/Program Files/nodejs/node.exe');
  assert.equal(entry.insert[0]!.config.cwd, 'D:/work/dmn');
  assert.deepEqual(entry.insert[0]!.config.args, ['--import', 'tsx', 'D:/work/dmn/src/mcp-stdio.ts', 'D:/work/dmn']);
  assert.equal(entry.insert[0]!.config.env.DEEPSEEK_API_KEY, 'process.env.DEEPSEEK_API_KEY');
});

test('upsertMcpEntry keeps a comments-only profile readable and in order', () => {
  const { text, changed } = upsertMcpEntry('# only comments\n', options);
  assert.equal(changed, true);
  assert.match(text, /# only comments/);
  assert.equal(hasMcpEntry(text), true);
  assert.equal(parse(text).length, 1);
});

test('upsertMcpEntry preserves existing entries, comments and unrelated settings', () => {
  const original = `${DEFAULT_PATCH_HEADER}- id: ui-chat\n  config:\n    transcriptView: standard\n`;
  const { text } = upsertMcpEntry(original, options);
  assert.match(text, /- id: ui-chat\n {2}config:\n {4}transcriptView: standard/);
  assert.match(text, /# Your patch layer/);
  const document = parse(text);
  assert.equal(document.length, 2);
  assert.equal((document[1] as unknown as { insert: { id: string }[] }).insert[0]!.id, 'mcp-dmn');
});

test('upsertMcpEntry is idempotent and leaves the file untouched on the second run', () => {
  const first = upsertMcpEntry('[]\n', options);
  const second = upsertMcpEntry(first.text, options);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
  assert.equal(hasMcpEntry(second.text), true);
});

test('buildMcpEntry and toPosixPath normalise Windows separators', () => {
  assert.equal(toPosixPath('D:\\work\\dmn\\src\\mcp-stdio.ts'), 'D:/work/dmn/src/mcp-stdio.ts');
  const entry = JSON.stringify(buildMcpEntry({ root: 'D:\\work\\dmn', command: 'C:\\node\\node.exe' }));
  assert.match(entry, /D:\/work\/dmn\/src\/mcp-stdio\.ts/);
  assert.doesNotMatch(entry, /\\\\/);
});

test('upsertMcpEntry rejects malformed documents instead of rewriting them', () => {
  assert.throws(() => upsertMcpEntry('foo: bar\n', options), /Unexpected Desktop patch format/);
  assert.throws(() => upsertMcpEntry('- a: [\n', options), /Invalid Desktop patch YAML/);
  assert.equal(hasMcpEntry('[]\n'), false);
});
