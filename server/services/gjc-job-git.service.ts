import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

import { getDatabasePath } from '../modules/database/connection.js';
import { GjcGitClient } from './gjc-git-client.js';
import { GjcJobsClient } from './gjc-jobs-client.js';

type JobSnapshot = { jobId: string; worktreeId?: string | null; branch?: string | null; repositoryRoot?: string | null; baseCommit?: string | null };
type Worktree = { worktreeId?: string; path?: string; branch?: string };
type Jobs = { get(params: Record<string, unknown>): Promise<unknown> };
type Git = { list(params?: Record<string, unknown>): Promise<unknown>; status(params: Record<string, unknown>): Promise<unknown> };

function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid job authority response.'); return value as Record<string, unknown>; }
function snapshot(value: unknown): JobSnapshot { const item = record(value); if (typeof item.jobId !== 'string') throw new Error('Invalid job authority response.'); return item as JobSnapshot; }
function items(value: unknown): Worktree[] { const item = record(value); return Array.isArray(item.items) ? item.items.filter((entry): entry is Worktree => Boolean(entry) && typeof entry === 'object') : []; }
function execute(cwd: string, args: string[]): Promise<string> { return new Promise((resolve, reject) => { const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `git ${args[0]} failed`))); }); }

/** Resolves git operations from an immutable job binding, never a client-supplied path. */
export class GjcJobGitService {
  constructor(private readonly jobs: Jobs, private readonly gitForRoot: (root: string) => Git) {}

  async resolve(jobId: string): Promise<{ job: JobSnapshot; path: string; git: Git }> {
    const job = snapshot(await this.jobs.get({ jobId }));
    if (!job.repositoryRoot || !job.worktreeId || !job.branch || !job.baseCommit) throw new Error('Job has no complete worktree binding.');
    const git = this.gitForRoot(job.repositoryRoot);
    const worktree = items(await git.list({})).find(item => item.worktreeId === job.worktreeId);
    if (!worktree || typeof worktree.path !== 'string' || worktree.branch !== job.branch) throw new Error('Stored worktree is unavailable or no longer on the job branch.');
    await git.status({ jobId, branch: job.branch, path: worktree.path });
    return { job, path: worktree.path, git };
  }

  async status(jobId: string): Promise<unknown> { const binding = await this.resolve(jobId); return binding.git.status({ jobId, branch: binding.job.branch, path: binding.path }); }
  async diff(jobId: string): Promise<{ baseCommit: string; patch: string }> { const binding = await this.resolve(jobId); return { baseCommit: binding.job.baseCommit!, patch: await execute(binding.path, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', binding.job.baseCommit!]) }; }
  async publish(jobId: string): Promise<{ branch: string }> { const binding = await this.resolve(jobId); await execute(binding.path, ['push', '-u', 'origin', binding.job.branch!]); return { branch: binding.job.branch! }; }
  async hasCommits(jobId: string): Promise<boolean> { const binding = await this.resolve(jobId); return Boolean((await execute(binding.path, ['rev-list', '--max-count=1', `${binding.job.baseCommit}..HEAD`])).trim()); }
  async prContext(jobId: string): Promise<{ branch: string; baseBranch: string; remoteUrl: string }> {
    const binding = await this.resolve(jobId);
    if (!await this.hasCommits(jobId)) throw new Error('Cannot create a pull request: the job branch has no commits beyond its base commit.');
    const reference = await execute(binding.path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const baseBranch = reference.trim().replace(/^refs\/remotes\/origin\//u, '');
    if (!baseBranch) throw new Error('Unable to determine the remote default branch.');
    return { branch: binding.job.branch!, baseBranch, remoteUrl: (await execute(binding.path, ['remote', 'get-url', 'origin'])).trim() };
  }
}

let production: GjcJobGitService | undefined;
export function getProductionGjcJobGitService(): GjcJobGitService {
  if (production) return production;
  const clients = new Map<string, GjcGitClient>();
  production = new GjcJobGitService(new GjcJobsClient({ database: join(dirname(getDatabasePath()), 'jobs.sqlite3') }), root => {
    let client = clients.get(root);
    if (!client) { client = new GjcGitClient({ workdir: root }); clients.set(root, client); }
    return client;
  });
  return production;
}
