import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getGjcWorkerSupervisor, type GjcWorkerOptions, type GjcWorkerRun, type GjcWorkerSpawnRun, type GjcWorkerWriter } from '../gjc-worker-client.js';
import { getDatabasePath } from '../modules/database/connection.js';
import { GjcGitClient } from './gjc-git-client.js';
import { GjcJobsClient, GjcJobsClientError } from './gjc-jobs-client.js';

export type JobState = 'Waiting' | 'Reserved' | 'Queued' | 'Running' | 'Aborting' | 'Completed' | 'Failed' | 'Aborted' | 'Interrupted' | 'Ready';
type Lease = { owner: string; generation: number };
type RunSnapshot = { runId: string; appSessionId?: string | null; providerSessionId?: string | null };
type JobSnapshot = { jobId: string; provider?: string; state: string; lease?: Lease | null; worktreeId?: string | null; branch?: string | null; repositoryRoot?: string | null; baseCommit?: string | null; currentRun?: RunSnapshot | null; dispatchCheckpoint?: unknown; lastSequence?: number };
type Binding = { jobId: string; state: string; providerSessionId?: string | null };
export type JobAuthority = {
  reserveStart(params: Record<string, unknown>): Promise<unknown>; turnAdmit(params: Record<string, unknown>): Promise<unknown>; prepare(params: Record<string, unknown>): Promise<unknown>; admit(params: Record<string, unknown>): Promise<unknown>; readmit(params: Record<string, unknown>): Promise<unknown>;
  transition(params: Record<string, unknown>): Promise<unknown>; markDispatching(params: Record<string, unknown>): Promise<unknown>; runFinalize(params: Record<string, unknown>): Promise<unknown>; appendEvent(params: Record<string, unknown>): Promise<unknown>; get(params: Record<string, unknown>): Promise<unknown>;
  bindingResolve(params: Record<string, unknown>): Promise<unknown>; bindingRelease(params: Record<string, unknown>): Promise<unknown>; interruptForShutdown(): Promise<unknown>; reconcile(params?: Record<string, unknown>): Promise<unknown>; bindProviderSession(params: Record<string, unknown>): Promise<unknown>;
};
export type GitWorktrees = { create(params: Record<string, unknown>): Promise<unknown>; list(params?: Record<string, unknown>): Promise<unknown>; status(params?: Record<string, unknown>): Promise<unknown> };
export type JobSupervisor = { spawnRun(input: GjcWorkerSpawnRun): GjcWorkerRun; abort(alias: string): Promise<boolean> };
export type JobOrchestratorOptions = GjcWorkerOptions & { writer: GjcWorkerWriter; appSessionId?: string; message?: string; jobId?: string; cap?: number; provider?: string; dispatched?: boolean };
export type JobRunHandle = { jobId: string; runId?: string; state: string; started: Promise<void>; completion: Promise<void>; abortHandle: string };
export type JobOrchestratorDependencies = { jobs: JobAuthority; git?: GitWorktrees; gitForProject?: (projectRoot: string) => GitWorktrees; supervisor: JobSupervisor; owner?: string; createId?: () => string; broadcast?: (jobId: string, event: unknown) => void };
export class GjcCapacityExhaustedError extends Error { constructor(public readonly jobId: string) { super(`GJC job ${jobId} is waiting for capacity.`); this.name = 'GjcCapacityExhaustedError'; } }

const safe = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = (value: string) => value.toLowerCase();
const eventId = () => `event-${randomUUID()}`;
function snapshot(value: unknown): JobSnapshot { if (!safe(value) || typeof value.jobId !== 'string' || typeof value.state !== 'string') throw new Error('Invalid jobs authority response.'); return value as JobSnapshot; }
function binding(value: unknown): Binding { if (!safe(value) || typeof value.jobId !== 'string' || typeof value.state !== 'string') throw new Error('Invalid job binding response.'); return value as Binding; }
function lease(value: JobSnapshot): Lease { if (!value.lease || typeof value.lease.owner !== 'string' || !Number.isSafeInteger(value.lease.generation)) throw new Error('Job has no active lease.'); return value.lease; }
function worktree(value: unknown): { worktreeId: string; path: string; head?: string } { const item = safe(value) && safe(value.worktree) ? value.worktree : undefined; if (!item || typeof item.worktreeId !== 'string' || typeof item.path !== 'string') throw new Error('Invalid git worktree.create response.'); return item as { worktreeId: string; path: string; head?: string }; }
function worktreePath(value: unknown, id: string): string | undefined { const items = Array.isArray(value) ? value : safe(value) && Array.isArray(value.items) ? value.items : []; const item = items.find((candidate) => safe(candidate) && candidate.worktreeId === id && typeof candidate.path === 'string'); return safe(item) && typeof item.path === 'string' ? item.path : undefined; }
function sameFence(current: JobSnapshot, runId: string, expected: Lease): boolean { return current.currentRun?.runId === runId && current.lease?.owner === expected.owner && current.lease?.generation === expected.generation; }

/** Durable v5 facade: Job is a bound workspace; every dispatch creates one fenced Run. */
export class JobOrchestrator {
  private readonly owner: string; private readonly createId: () => string;
  private readonly queues = new Map<string, Promise<unknown>>(); private readonly activeRuns = new Map<string, { runId: string; lease: Lease; abortHandle: string }>();
  constructor(private readonly deps: JobOrchestratorDependencies) { this.owner = deps.owner ?? `orchestrator-${randomUUID()}`; this.createId = deps.createId ?? randomUUID; }
  private git(root: string): GitWorktrees { const client = this.deps.gitForProject?.(root) ?? this.deps.git; if (!client) throw new Error('GJC Git worktree client is unavailable.'); return client; }
  private serial<T>(jobId: string, action: () => Promise<T>): Promise<T> { const prior = this.queues.get(jobId) ?? Promise.resolve(); const result = prior.catch(() => undefined).then(action); const tail = result.catch(() => undefined).finally(() => { if (this.queues.get(jobId) === tail) this.queues.delete(jobId); }); this.queues.set(jobId, tail); return result; }
  private params(jobId: string, current: JobSnapshot): Record<string, unknown> { return { jobId, lease: lease(current) }; }
  private async mutate(jobId: string, action: () => Promise<unknown>, confirmed: (value: JobSnapshot) => boolean): Promise<JobSnapshot> { try { return snapshot(await action()); } catch (error) { const fresh = snapshot(await this.deps.jobs.get({ jobId })); if (confirmed(fresh)) return fresh; throw error; } }
  private async finalize(jobId: string, current: JobSnapshot, runId: string, state: 'succeeded' | 'failed' | 'aborted' | 'interrupted', payload: unknown): Promise<JobSnapshot> { const id = eventId(); return this.mutate(jobId, () => this.deps.jobs.runFinalize({ ...this.params(jobId, current), runId, terminalRunState: state, eventId: id, payload }), (fresh) => lower(fresh.state) === state || (!sameFence(fresh, runId, lease(current)) && (lower(fresh.state) === 'ready' || lower(fresh.state) === 'interrupted'))); }
  private enqueueEvent(jobId: string, current: JobSnapshot, runId: string, payload: unknown, writer: GjcWorkerWriter, failure: (error: unknown) => void): void {
    const id = eventId(); const expected = lease(current);
    void this.serial(jobId, async () => {
      const fresh = snapshot(await this.deps.jobs.get({ jobId }));
      if (!sameFence(fresh, runId, expected)) return; // late worker settlement is fenced off.
      await this.deps.jobs.appendEvent({ ...this.params(jobId, fresh), runId, eventId: id, payload });
      this.deps.broadcast?.(jobId, payload); writer.send(payload);
    }).catch(failure);
  }
  private writer(jobId: string, current: JobSnapshot, runId: string, writer: GjcWorkerWriter, failure: (error: unknown) => void): GjcWorkerWriter { return { ...writer, send: (payload) => this.enqueueEvent(jobId, current, runId, payload, writer, failure), setSessionId: (providerSessionId) => { void this.serial(jobId, async () => { const fresh = snapshot(await this.deps.jobs.get({ jobId })); if (!sameFence(fresh, runId, lease(current))) return; await this.deps.jobs.bindProviderSession({ ...this.params(jobId, fresh), runId, providerSessionId }); writer.setSessionId?.(providerSessionId); }).catch(failure); } }; }
  private completion(jobId: string, runId: string, expected: Lease, run: GjcWorkerRun): Promise<void> { return run.completion.then(() => this.serial(jobId, async () => { const fresh = snapshot(await this.deps.jobs.get({ jobId })); if (!sameFence(fresh, runId, expected)) return; await this.finalize(jobId, fresh, runId, 'succeeded', { kind: 'completed' }); this.activeRuns.delete(jobId); }), (error) => this.serial(jobId, async () => { const fresh = snapshot(await this.deps.jobs.get({ jobId })); if (!sameFence(fresh, runId, expected)) return; await this.finalize(jobId, fresh, runId, 'failed', { kind: 'failed', error: error instanceof Error ? error.message : 'Worker failed.' }); this.activeRuns.delete(jobId); })); }
  private async dispatch(jobId: string, current: JobSnapshot, runId: string, appSessionId: string, message: string, options: JobOrchestratorOptions, cwd: string, sessionId?: string | null): Promise<JobRunHandle> {
    current = await this.mutate(jobId, () => this.deps.jobs.markDispatching({ ...this.params(jobId, current), runId }), (fresh) => Boolean(fresh.dispatchCheckpoint));
    const expected = lease(current); let run: GjcWorkerRun | undefined;
    const persistenceFailure = (_error: unknown) => { /* completion/fence keeps authority state authoritative; no speculative settlement. */ };
    run = this.deps.supervisor.spawnRun({ runId, appSessionId, message, options: { ...options, cwd, sessionId }, writer: this.writer(jobId, current, runId, options.writer, persistenceFailure) });
    this.activeRuns.set(jobId, { runId, lease: expected, abortHandle: run.abortHandle });
    await run.started;
    current = await this.mutate(jobId, () => this.deps.jobs.transition({ ...this.params(jobId, current), state: 'running' }), (fresh) => lower(fresh.state) === 'running');
    return { jobId, runId, state: current.state, started: run.started, completion: this.completion(jobId, runId, expected, run), abortHandle: run.abortHandle };
  }
  async start(provider: string, appSessionId: string, projectRoot: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle>;
  async start(projectRoot: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle>;
  async start(providerOrRoot: string, appSessionOrMessage: string, rootOrOptions: string | JobOrchestratorOptions, suppliedMessage?: string, suppliedOptions?: JobOrchestratorOptions): Promise<JobRunHandle> {
    const legacy = typeof rootOrOptions !== 'string'; const options = (legacy ? rootOrOptions : suppliedOptions)!; const provider = legacy ? options.provider ?? 'gjc' : providerOrRoot; const appSessionId = legacy ? options.appSessionId! : appSessionOrMessage; const projectRoot = legacy ? providerOrRoot : rootOrOptions; const message = legacy ? appSessionOrMessage : suppliedMessage!;
    if (!provider || !appSessionId) throw new Error('A provider and app session are required.'); const suffix = this.createId().replace(/[^a-z0-9]/giu, '').toLowerCase().slice(-12); const jobId = options.jobId ?? `job-${suffix}`;
    return this.serial(jobId, async () => { let current: JobSnapshot; try { current = snapshot(await this.deps.jobs.reserveStart({ jobId, provider, appSessionId, owner: this.owner, cap: options.cap ?? 4 })); } catch (error) { if (error instanceof GjcJobsClientError && error.code === 'capacity_exhausted') throw new GjcCapacityExhaustedError(jobId); throw error; } if (lower(current.state) === 'waiting') throw new GjcCapacityExhaustedError(jobId); const branch = `job/${jobId}`; const path = join(projectRoot, '.gjc-worktrees', jobId); const created = worktree(await this.git(projectRoot).create({ jobId, path, branch })); if (!created.head) throw new Error('worktree.create did not return a base commit.'); current = await this.mutate(jobId, () => this.deps.jobs.prepare({ ...this.params(jobId, current), worktreeId: created.worktreeId, branch, baseCommit: created.head, repositoryRoot: projectRoot }), (fresh) => fresh.worktreeId === created.worktreeId); const runId = `run-${this.createId()}`; current = await this.mutate(jobId, () => this.deps.jobs.admit({ ...this.params(jobId, current), runId, appSessionId }), (fresh) => fresh.currentRun?.runId === runId); return this.dispatch(jobId, current, runId, appSessionId, message, options, created.path); });
  }
  async turnStart(provider: string, appSessionId: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> { const bound = binding(await this.deps.jobs.bindingResolve({ provider, appSessionId })); if (lower(bound.state) !== 'ready') throw new Error('Only ready jobs can start a new turn.'); return this.serial(bound.jobId, async () => { const runId = `run-${this.createId()}`; let current: JobSnapshot; try { current = snapshot(await this.deps.jobs.turnAdmit({ jobId: bound.jobId, appSessionId, owner: this.owner, runId, cap: options.cap ?? 4 })); } catch (error) { if (error instanceof GjcJobsClientError && error.code === 'capacity_exhausted') throw new GjcCapacityExhaustedError(bound.jobId); throw error; } if (!current.worktreeId) throw new Error('Ready job has no worktree.'); const cwd = worktreePath(await this.git(current.repositoryRoot ?? dirname(dirname(current.worktreeId))).list({}), current.worktreeId); if (!cwd) throw new Error('Stored worktree is no longer available.'); return this.dispatch(bound.jobId, current, runId, appSessionId, message, options, cwd, bound.providerSessionId); }); }
  async resume(jobId: string, appSessionId: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle>;
  async resume(jobId: string, options: JobOrchestratorOptions): Promise<JobRunHandle>;
  async resume(jobId: string, appSessionOrOptions: string | JobOrchestratorOptions, suppliedMessage?: string, suppliedOptions?: JobOrchestratorOptions): Promise<JobRunHandle> {
    const legacy = typeof appSessionOrOptions !== 'string'; const options = (legacy ? appSessionOrOptions : suppliedOptions)!; const appSessionId = legacy ? options.appSessionId! : appSessionOrOptions; const message = legacy ? options.message ?? '' : suppliedMessage!; const provider = options.provider ?? (legacy ? 'gjc' : undefined);
    if (!provider || !appSessionId) throw new Error('A provider and app session are required.');
    return this.serial(jobId, async () => { const current = snapshot(await this.deps.jobs.get({ jobId })); if (lower(current.state) !== 'interrupted' || !current.worktreeId || !current.branch) throw new Error('Only interrupted jobs with a worktree can be resumed.'); const bound = binding(await this.deps.jobs.bindingResolve({ provider, appSessionId })); if (bound.jobId !== jobId) throw new Error('Session binding does not belong to this job.'); const root = current.repositoryRoot ?? dirname(dirname(current.worktreeId)); const git = this.git(root); const cwd = worktreePath(await git.list({}), current.worktreeId); if (!cwd) throw new Error('Stored worktree is no longer available.'); await git.status({ jobId, branch: current.branch, path: cwd }); const runId = `run-${this.createId()}`; let admitted: JobSnapshot; try { admitted = snapshot(await this.deps.jobs.readmit({ jobId, appSessionId, owner: this.owner, cap: options.cap ?? 4, runId })); } catch (error) { if (error instanceof GjcJobsClientError && error.code === 'capacity_exhausted') throw new GjcCapacityExhaustedError(jobId); throw error; } return this.dispatch(jobId, admitted, runId, appSessionId, message, options, cwd, bound.providerSessionId); });
  }
  async abort(target: { jobId?: string; appSessionId?: string; provider?: string } | string): Promise<boolean> { const jobId = typeof target === 'string' ? target : target.jobId ?? binding(await this.deps.jobs.bindingResolve({ provider: target.provider, appSessionId: target.appSessionId })).jobId; return this.serial(jobId, async () => { let current = snapshot(await this.deps.jobs.get({ jobId })); if (lower(current.state) !== 'running' && lower(current.state) !== 'aborting') return false; if (lower(current.state) === 'running') current = snapshot(await this.deps.jobs.transition({ ...this.params(jobId, current), state: 'aborting' })); const active = this.activeRuns.get(jobId); if (!active || !await this.deps.supervisor.abort(active.abortHandle)) return false; const fresh = snapshot(await this.deps.jobs.get({ jobId })); if (sameFence(fresh, active.runId, active.lease)) await this.finalize(jobId, fresh, active.runId, 'aborted', { kind: 'aborted' }); this.activeRuns.delete(jobId); return true; }); }
  async interruptForShutdown(): Promise<unknown> { const result = await this.deps.jobs.interruptForShutdown(); this.activeRuns.clear(); return result; }
  async resolveBinding(provider: string, appSessionId: string): Promise<Binding | null> {
    try {
      return binding(await this.deps.jobs.bindingResolve({ provider, appSessionId }));
    } catch (error) {
      if (error instanceof GjcJobsClientError && error.code === 'not_found') return null;
      throw error;
    }
  }
  reconcile(): Promise<unknown> { return this.deps.jobs.reconcile({}); }
}
type ProductionOrchestrator = JobOrchestrator & { close(): void }; let production: ProductionOrchestrator | undefined;
export function getProductionJobOrchestrator(): ProductionOrchestrator { if (production) return production; const database = join(dirname(getDatabasePath()), 'jobs.sqlite3'); const jobs = new GjcJobsClient({ database }); const clients = new Map<string, GjcGitClient>(); const gitForProject = (projectRoot: string): GjcGitClient => { if (!projectRoot) throw new Error('GJC requires a project root.'); if (!existsSync(join(projectRoot, '.git'))) throw new Error(`GJC project root is not a Git repository: ${projectRoot}`); let client = clients.get(projectRoot); if (!client) { client = new GjcGitClient({ workdir: projectRoot }); clients.set(projectRoot, client); } return client; }; const orchestrator = new JobOrchestrator({ jobs, gitForProject, supervisor: getGjcWorkerSupervisor() }) as ProductionOrchestrator; orchestrator.close = () => { jobs.close(); for (const client of clients.values()) client.close(); clients.clear(); production = undefined; }; void mkdir(dirname(database), { recursive: true }).catch(() => {}); production = orchestrator; return orchestrator; }
