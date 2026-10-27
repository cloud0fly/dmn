import { constants, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPatchFile, resolveProfileDir, toPosixPath, upsertMcpEntry } from './mcp-patch.ts';

// Explicit local installer; no credentials, sessions, default routes or other plugins are rewritten.
// Honours DSH_PROFILE_DIR / DSH_HOME / DSH_PROFILE so non-default profiles keep working.
function main(): number {
  const location = resolveProfileDir();
  const profile = join(location.dir, 'cordis.patch.yml');
  const root = toPosixPath(resolve('.'));
  const existing = readPatchFile(profile);

  let result: { text: string; changed: boolean };
  try {
    result = upsertMcpEntry(existing.text, { root, command: toPosixPath(process.execPath) });
  } catch (error) {
    console.error(`mcp-dmn installer: ${(error as Error).message}`);
    return 1;
  }

  if (!result.changed) {
    console.error(JSON.stringify({ installed: 'mcp-dmn', changed: false, reason: 'already-configured', profile }));
    return 0;
  }

  mkdirSync(location.dir, { recursive: true });
  let backup: string | null = null;
  if (existing.existed) {
    backup = `${profile}.dmn-p3-${Date.now()}.bak`;
    copyFileSync(profile, backup, constants.COPYFILE_EXCL);
  }
  const temporary = `${profile}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, result.text, { encoding: 'utf8' });
    renameSync(temporary, profile);
  } catch (error) {
    if (existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* best effort */ } }
    console.error(`mcp-dmn installer: failed to write ${profile}: ${(error as Error).message}`);
    return 1;
  }
  console.error(JSON.stringify({ installed: 'mcp-dmn', changed: true, profile, profileSource: location.source, backup }));
  return 0;
}

process.exitCode = main();
