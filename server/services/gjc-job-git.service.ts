import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { JobGitDiffResponse } from '../../shared/gjc-job-projection-protocol.js';

import { GjcGitClient } from './gjc-git-client.js';

type JobSnapshot = { jobId: string; worktreeId?: string | null; branch?: string | null; repositoryRoot?: string | null; baseCommit?: string | null };
type Worktree = { worktreeId?: string; path?: string; branch?: string };
type Jobs = {
  get(params: Record<string, unknown>): Promise<unknown>;
  appendAdminEvent(params: Record<string, unknown>): Promise<unknown>;
};
const MAX_COMMIT_MESSAGE = 4096;
const MAX_COMMIT_PATHS = 100;
const MAX_COMMIT_PATH = 1024;
function commitInput(message: unknown, paths: unknown): { message: string; paths: string[] } {
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_COMMIT_MESSAGE) throw Object.assign(new Error('Invalid commit message.'), { code: 'invalid_request' });
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_COMMIT_PATHS || paths.some(path => typeof path !== 'string' || !path || path.length > MAX_COMMIT_PATH || path.startsWith('/') || path.split('/').includes('..'))) throw Object.assign(new Error('Invalid commit paths.'), { code: 'invalid_request' });
  return { message: message.trim(), paths: [...new Set(paths)] };
}
type Git = {
  list(params?: Record<string, unknown>): Promise<unknown>;
  status(params: Record<string, unknown>): Promise<unknown>;
  diff(params: Record<string, unknown>): Promise<unknown>;
};

function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid job authority response.'); return value as Record<string, unknown>; }
function snapshot(value: unknown): JobSnapshot { const item = record(value); if (typeof item.jobId !== 'string') throw new Error('Invalid job authority response.'); return item as JobSnapshot; }
function items(value: unknown): Worktree[] { const item = record(value); return Array.isArray(item.items) ? item.items.filter((entry): entry is Worktree => Boolean(entry) && typeof entry === 'object') : []; }
/** Resolves git operations from an immutable job binding, never a client-supplied path. */
function execute(cwd: string, args: string[]): Promise<string> { return new Promise((resolve, reject) => { const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `git ${args[0]} failed`))); }); }
export class GjcJobGitService {
  constructor(private readonly jobs: Jobs, private readonly gitForRoot: (root: string) => Git, private readonly publishAdminEvent?: (jobId: string, eventId: string, payload: Record<string, unknown>) => Promise<void>) {}

  async resolve(jobId: string): Promise<{ job: JobSnapshot; path: string; git: Git }> {
    const job = snapshot(await this.jobs.get({ jobId }));
    if (!job.repositoryRoot || !job.worktreeId || !job.branch || !job.baseCommit) throw new Error('Job has no complete worktree binding.');
    const git = this.gitForRoot(job.repositoryRoot);
    const worktree = items(await git.list({})).find(item => item.worktreeId === job.worktreeId);
    if (!worktree || typeof worktree.path !== 'string' || worktree.branch !== job.branch) throw new Error('Stored worktree is unavailable or no longer on the job branch.');
    await git.status({ jobId, branch: job.branch, path: worktree.path });
    return { job, path: worktree.path, git };
  }
  private async recordAdminEvent(jobId: string, eventId: string, payload: Record<string, unknown>): Promise<void> {
    if (this.publishAdminEvent) await this.publishAdminEvent(jobId, eventId, payload);
    else await this.jobs.appendAdminEvent({ jobId, eventId, payload });
  }

  private async lifecycle<T>(jobId: string, operation: 'publish' | 'pr', action: () => Promise<T>): Promise<T> {
    const attempt = randomUUID();
    await this.recordAdminEvent(jobId, `${operation}.${attempt}.started`, { attempt });
    try {
      const result = await action();
      await this.recordAdminEvent(jobId, `${operation}.${attempt}.completed`, { attempt });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024);
      await this.recordAdminEvent(jobId, `${operation}.${attempt}.failed`, { attempt, message });
      throw error;
    }
  }

  async status(jobId: string): Promise<unknown> { const binding = await this.resolve(jobId); return binding.git.status({ jobId, branch: binding.job.branch, path: binding.path }); }
  async diff(jobId: string): Promise<JobGitDiffResponse> {
    const binding = await this.resolve(jobId);
    const value = await binding.git.diff({ jobId, branch: binding.job.branch, path: binding.path, mode: 'base', baseCommit: binding.job.baseCommit, includeUntracked: true });
    const response = record(value);
    const text = Buffer.isBuffer(response.patch) ? response.patch.toString('utf8') : typeof response.patch === 'string' ? response.patch : '';
    const source = Array.isArray(response.paths) ? response.paths : Array.isArray(response.changedPaths) ? response.changedPaths : [...text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)].map(match => match[2]);
    const paths = [...new Set(source.filter((path): path is string => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..')))];
    return { text, paths };
  }
  async publish(jobId: string): Promise<{ branch: string }> {
    return this.lifecycle(jobId, 'publish', async () => {
      const binding = await this.resolve(jobId);
      await execute(binding.path, ['push', '-u', 'origin', binding.job.branch!]);
      return { branch: binding.job.branch! };
    });
  }
  async hasCommits(jobId: string): Promise<boolean> { const binding = await this.resolve(jobId); return Boolean((await execute(binding.path, ['rev-list', '--max-count=1', `${binding.job.baseCommit}..HEAD`])).trim()); }
  async commit(jobId: string, message: unknown, paths: unknown): Promise<{ commit: string; eventId: string }> {
    const input = commitInput(message, paths);
    const binding = await this.resolve(jobId);
    const changed = new Set((await execute(binding.path, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean).map(line => line.slice(3).replace(/^"|"$/gu, '')));
    if (input.paths.some(path => !changed.has(path))) throw Object.assign(new Error('Commit paths must be currently changed relative paths.'), { code: 'invalid_request' });
    await execute(binding.path, ['add', '--', ...input.paths]);
    await execute(binding.path, ['commit', '--only', '-m', input.message, '--', ...input.paths]);
    const commit = (await execute(binding.path, ['rev-parse', 'HEAD'])).trim();
    const eventId = `commit.${randomUUID()}`;
    await this.recordAdminEvent(jobId, eventId, { kind: 'git_commit', commit, paths: input.paths });
    return { commit, eventId };
  }
  async createPullRequest<T>(jobId: string, create: (context: { branch: string; baseBranch: string; remoteUrl: string }) => Promise<T>): Promise<T> {
    return this.lifecycle(jobId, 'pr', async () => {
      const binding = await this.resolve(jobId);
      if (!await this.hasCommits(jobId)) throw new Error('Cannot create a pull request: the job branch has no commits beyond its base commit.');
      const reference = await execute(binding.path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
      const baseBranch = reference.trim().replace(/^refs\/remotes\/origin\//u, '');
      if (!baseBranch) throw new Error('Unable to determine the remote default branch.');
      return create({ branch: binding.job.branch!, baseBranch, remoteUrl: (await execute(binding.path, ['remote', 'get-url', 'origin'])).trim() });
    });
  }
  async prContext(jobId: string): Promise<{ branch: string; baseBranch: string; remoteUrl: string }> {
    return this.createPullRequest(jobId, async context => context);
  }
}

let production: GjcJobGitService | undefined;
export function getProductionGjcJobGitService(jobs: Jobs, publishAdminEvent?: (jobId: string, eventId: string, payload: Record<string, unknown>) => Promise<void>): GjcJobGitService {
  if (production) return production;
  const clients = new Map<string, GjcGitClient>();
  production = new GjcJobGitService(jobs, root => {
    let client = clients.get(root);
    if (!client) { client = new GjcGitClient({ workdir: root }); clients.set(root, client); }
    return client;
  }, publishAdminEvent);
  return production;
}
