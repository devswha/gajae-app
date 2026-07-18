import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontMatter } from '@/shared/frontmatter.js';

export type LiveGjcCommandNamespace = 'user' | 'project' | 'skill';

export interface LiveGjcCommand {
  /** Slash invocation, e.g. `/omg:easy` or `/my-skill`. */
  name: string;
  description: string;
  namespace: LiveGjcCommandNamespace;
  scope: string;
  sourcePath?: string;
}

// Bound the scan so a pathological command tree can't stall the request.
const MAX_COMMANDS = 500;

async function scanInto(
  dir: string,
  baseDir: string,
  namespace: 'user' | 'project',
  out: LiveGjcCommand[],
): Promise<void> {
  if (out.length >= MAX_COMMANDS) {
    return;
  }

  // Missing / unreadable dir (no native or project commands) is not an error.
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS) {
      return;
    }
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await scanInto(fullPath, baseDir, namespace, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const content = await fs.readFile(fullPath, 'utf8').catch(() => null);
    if (content === null) {
      continue;
    }

    const { data: frontmatter, content: body } = parseFrontMatter(content);
    const relativePath = path.relative(baseDir, fullPath);
    // The command name IS the file's relative path (native install writes the
    // command filename verbatim, e.g. `omg:easy.md` -> `/omg:easy`).
    const name = `/${relativePath.replace(/\.md$/i, '').replace(/\\/g, '/')}`;

    let description =
      frontmatter && typeof frontmatter.description === 'string' ? frontmatter.description : '';
    if (!description) {
      const firstLine = body.trim().split('\n')[0] ?? '';
      description = firstLine.replace(/^#+\s*/, '').trim();
    }

    out.push({ name, description, namespace, scope: namespace, sourcePath: fullPath });
  }
}

/**
 * Recursively enumerates markdown command files under `rootDir`, mapping each
 * file's path (relative to `rootDir`) to a `/slash` command name. Pure over the
 * filesystem: a missing/unreadable directory yields `[]` rather than throwing.
 */
export async function scanGjcCommandDirectory(
  rootDir: string,
  namespace: 'user' | 'project',
): Promise<LiveGjcCommand[]> {
  const out: LiveGjcCommand[] = [];
  await scanInto(rootDir, rootDir, namespace, out);
  return out;
}

/** Keeps the first occurrence of each command name (native > project > skill). */
export function dedupeCommandsByName(commands: LiveGjcCommand[]): LiveGjcCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.name)) {
      return false;
    }
    seen.add(command.name);
    return true;
  });
}

/**
 * Enumerates the slash commands a live tmux gjc session can execute:
 * user-global native commands (`~/.gjc/agent/commands`), project commands
 * (`<workspace>/.gjc/commands`), and installed skills from the native GJC
 * user and project skill directories. Read-only; a failure in any source
 * degrades to a partial list rather than failing the whole request.
 */
export async function listLiveGjcCommands(workspacePath?: string): Promise<LiveGjcCommand[]> {
  const commands: LiveGjcCommand[] = [];

  const userCommandsDir = path.join(os.homedir(), '.gjc', 'agent', 'commands');
  commands.push(...(await scanGjcCommandDirectory(userCommandsDir, 'user')));

  if (workspacePath) {
    const projectCommandsDir = path.join(workspacePath, '.gjc', 'commands');
    commands.push(...(await scanGjcCommandDirectory(projectCommandsDir, 'project')));
  }

  try {
    const skillRoots: { scope: 'user' | 'project'; rootDir: string }[] = [
      { scope: 'user', rootDir: path.join(os.homedir(), '.gjc', 'agent', 'skills') },
    ];
    if (workspacePath) {
      skillRoots.push({
        scope: 'project',
        rootDir: path.join(workspacePath, '.gjc', 'skills'),
      });
    }
    for (const { scope, rootDir } of skillRoots) {
      const scanned = await scanGjcSkillRoot(rootDir, scope);
      commands.push(...scanned);
    }
  } catch {
    // Skills enumeration failure must not hide the file-based commands.
  }

  return dedupeCommandsByName(commands);
}

/**
 * Scans a GJC skill root for markdown skill files and surfaces them as
 * slash-command rows tagged with the `skill` namespace. Skills use the `/`
 * invocation prefix.
 */
async function scanGjcSkillRoot(
  rootDir: string,
  scope: 'user' | 'project',
): Promise<LiveGjcCommand[]> {
  const out: LiveGjcCommand[] = [];
  await scanInto(rootDir, rootDir, scope, out);
  return out.slice(0, MAX_COMMANDS).map((command) => ({ ...command, namespace: 'skill' }));
}
