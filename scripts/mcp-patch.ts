import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML, { isMap, isScalar, isSeq, Scalar } from 'yaml';

/** Patch entry id used by the DMN operator MCP registration. */
export const MCP_ENTRY_ID = 'mcp-dmn';

/** Same header the current DSH profile templates ship with, used when creating a missing patch file. */
export const DEFAULT_PATCH_HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  ''
].join('\n');

export type ProfileLocation = { dir: string; source: 'DSH_PROFILE_DIR' | 'DSH_HOME' | 'homedir' };

/** Resolve the active profile directory the same way the DSH launcher does. */
export function resolveProfileDir(env: NodeJS.ProcessEnv = process.env): ProfileLocation {
  if (env.DSH_PROFILE_DIR) return { dir: env.DSH_PROFILE_DIR, source: 'DSH_PROFILE_DIR' };
  if (env.DSH_HOME) return { dir: join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop'), source: 'DSH_HOME' };
  return { dir: join(homedir(), '.dsh', 'profiles', env.DSH_PROFILE || 'desktop'), source: 'homedir' };
}

/** DSH loads patch entries into a YAML document; Windows paths must be quoted with forward slashes. */
export function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

/** Read the profile patch file. Missing/empty files start from the shipped header instead of failing. */
export function readPatchFile(path: string): { text: string; existed: boolean } {
  if (!existsSync(path)) return { text: DEFAULT_PATCH_HEADER, existed: false };
  const text = readFileSync(path, 'utf8');
  return { text: text.trim().length ? text : DEFAULT_PATCH_HEADER, existed: true };
}

function walkEntry(node: unknown): boolean {
  if (isMap(node)) {
    if (node.get('id') === MCP_ENTRY_ID) return true;
    return node.items.some(item => walkEntry(item.key) || walkEntry(item.value));
  }
  if (isSeq(node)) return node.items.some(item => walkEntry(item));
  return false;
}

export function hasMcpEntry(text: string): boolean {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`Invalid Desktop patch YAML: ${doc.errors[0]?.message ?? 'parse error'}`);
  return doc.contents ? walkEntry(doc.contents) : false;
}

export function buildMcpEntry(options: { root: string; command: string; modelserver?: string }): Record<string, unknown> {
  const root = toPosixPath(options.root);
  return {
    insert: [{
      id: MCP_ENTRY_ID,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: options.modelserver ?? 'dmn',
        transport: 'stdio',
        command: toPosixPath(options.command),
        args: ['--import', 'tsx', `${root}/src/mcp-stdio.ts`, root],
        cwd: root,
        toolCallTimeoutMs: 60000,
        failOnStartupError: false,
        env: { DEEPSEEK_API_KEY: 'process.env.DEEPSEEK_API_KEY' }
      }
    }]
  };
}

/**
 * Add the `mcp-dmn` insert entry to a profile patch document without rewriting the rest of the file
 * (comments, ordering and existing entries survive) and without relying on hand-computed indentation.
 */
export function upsertMcpEntry(text: string, options: { root: string; command: string; modelserver?: string }): { text: string; changed: boolean } {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`Invalid Desktop patch YAML: ${doc.errors[0]?.message ?? 'parse error'}`);
  // `yaml` types under exactOptionalPropertyTypes are narrower than the runtime nodes; keep the casts local.
  if (doc.contents === null) doc.contents = doc.createNode([]) as unknown as NonNullable<typeof doc.contents>;
  if (!isSeq(doc.contents)) throw new Error('Unexpected Desktop patch format: expected a top-level YAML array of patch entries.');
  if (walkEntry(doc.contents)) return { text, changed: false };
  const entry = doc.createNode(buildMcpEntry(options));
  const secret = entry.getIn(['insert', 0, 'config', 'env', 'DEEPSEEK_API_KEY'], true);
  if (!(secret instanceof Scalar)) throw new Error('Internal error: credential reference node was not created.');
  secret.tag = '!!js';
  const sequence = doc.contents as unknown as { items: unknown[] };
  sequence.items.push(entry);
  return { text: String(doc), changed: true };
}
