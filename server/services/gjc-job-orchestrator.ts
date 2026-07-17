import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getGjcWorkerSupervisor, type GjcWorkerOptions, type GjcWorkerRun, type GjcWorkerSpawnRun, type GjcWorkerWriter } from '../gjc-worker-client.js';
import { getDatabasePath } from '../modules/database/connection.js';
import { GjcGitClient } from './gjc-git-client.js';
import { GjcJobsClient, GjcJobsClientError } from './gjc-jobs-client.js';

export type JobState = 'Waiting' | 'Reserved' | 'Queued' | 'Running' | 'Aborting' | 'Completed' | 'Failed' | 'Aborted' | 'Interrupted';
type Lease = { owner: string; generation: number };
type RunSnapshot = { runId: string; appSessionId: string; providerSessionId?: string | null };
type JobSnapshot = { jobId: string; state: string; lease?: Lease | null; worktreeId?: string | null; branch?: string | null; currentRun?: RunSnapshot | null; dispatchCheckpoint?: unknown; runs?: RunSnapshot[]; lastSequence?: number };
export type JobAuthority = {
  reserve(params: Record<string, unknown>): Promise<unknown>; prepare(params: Record<string, unknown>): Promise<unknown>; admit(params: Record<string, unknown>): Promise<unknown>;
  readmit(params: Record<string, unknown>): Promise<unknown>; transition(params: Record<string, unknown>): Promise<unknown>; markDispatching(params: Record<string, unknown>): Promise<unknown>;
  finalize(params: Record<string, unknown>): Promise<unknown>; appendEvent(params: Record<string, unknown>): Promise<unknown>; get(params: Record<string, unknown>): Promise<unknown>;
  reconcile(params?: Record<string, unknown>): Promise<unknown>; bindProviderSession(params: Record<string, unknown>): Promise<unknown>;
};
export type GitWorktrees = { create(params: Record<string, unknown>): Promise<unknown>; list(params?: Record<string, unknown>): Promise<unknown>; status(params?: Record<string, unknown>): Promise<unknown> };
export type JobSupervisor = { spawnRun(input: GjcWorkerSpawnRun): GjcWorkerRun; abort(alias: string): Promise<boolean> };
export type JobOrchestratorOptions = GjcWorkerOptions & { appSessionId: string; writer: GjcWorkerWriter; message?: string; jobId?: string; cap?: number; provider?: string; providerSessionId?: string; dispatched?: boolean };
export type JobRunHandle = { jobId: string; runId?: string; state: string; started: Promise<void>; completion: Promise<void>; abortHandle: string };
export type JobOrchestratorDependencies = { jobs: JobAuthority; git?: GitWorktrees; gitForProject?: (projectRoot: string) => GitWorktrees; supervisor: JobSupervisor; owner?: string; createId?: () => string; broadcast?: (jobId: string, event: unknown) => void };
export class GjcCapacityExhaustedError extends Error {
  constructor(public readonly jobId: string) { super(`GJC job ${jobId} is waiting for capacity.`); this.name = 'GjcCapacityExhaustedError'; }
}

const terminal = new Set(['succeeded', 'failed', 'aborted']);
const safe = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const state = (value: string): string => value.toLowerCase();
function snapshot(value: unknown): JobSnapshot { if (!safe(value) || typeof value.jobId !== 'string' || typeof value.state !== 'string') throw new Error('Invalid jobs authority response.'); return value as JobSnapshot; }
function lease(value: JobSnapshot): Lease { if (!value.lease || typeof value.lease.owner !== 'string' || !Number.isSafeInteger(value.lease.generation)) throw new Error('Job has no active lease.'); return value.lease; }
function eventId(): string { return `event-${randomUUID()}`; }
function createdWorktree(value: unknown): { worktreeId: string; path: string } {
  const worktree = safe(value) && safe(value.worktree) ? value.worktree : undefined;
  if (!worktree || typeof worktree.worktreeId !== 'string' || typeof worktree.path !== 'string') throw new Error('Invalid git worktree.create response.');
  return { worktreeId: worktree.worktreeId, path: worktree.path };
}
function worktreePath(value: unknown, worktreeId: string): string | undefined {
  if (Array.isArray(value)) for (const item of value) if (safe(item) && item.worktreeId === worktreeId && typeof item.path === 'string') return item.path;
  return safe(value) && Array.isArray(value.items) ? worktreePath(value.items, worktreeId) : undefined;
}
function worktreeAtPath(value: unknown, path: string): { worktreeId: string; path: string } | undefined {
  const items = Array.isArray(value) ? value : safe(value) && Array.isArray(value.items) ? value.items : [];
  for (const item of items) {
    if (safe(item) && item.path === path && typeof item.worktreeId === 'string') return { worktreeId: item.worktreeId, path };
  }
  return undefined;
}

/** Durable job lifecycle facade. Jobs authority owns state; the supervisor only owns a live worker. */
export class JobOrchestrator {
  private readonly owner: string; private readonly createId: () => string;
  private readonly queues = new Map<string, Promise<unknown>>(); private readonly activeRuns = new Map<string, string>();
  constructor(private readonly deps: JobOrchestratorDependencies) { this.owner = deps.owner ?? `orchestrator-${randomUUID()}`; this.createId = deps.createId ?? randomUUID; }
  private git(projectRoot: string): GitWorktrees { const client = this.deps.gitForProject?.(projectRoot) ?? this.deps.git; if (!client) throw new Error('GJC Git worktree client is unavailable.'); return client; }
  private serial<T>(jobId: string, operation: () => Promise<T>): Promise<T> { const previous = this.queues.get(jobId) ?? Promise.resolve(); const result = previous.catch(() => {}).then(operation); const tail = result.catch(() => {}).finally(() => { if (this.queues.get(jobId) === tail) this.queues.delete(jobId); }); this.queues.set(jobId, tail); return result; }
  private params(jobId: string, current: JobSnapshot): Record<string, unknown> { return { jobId, lease: lease(current) }; }
  private async mutate(jobId: string, operation: () => Promise<unknown>, confirmed: (current: JobSnapshot) => boolean): Promise<JobSnapshot> {
    try { return snapshot(await operation()); } catch (error) { const current = snapshot(await this.deps.jobs.get({ jobId })); if (confirmed(current)) return current; throw error; }
  }
  private finalize(jobId: string, current: JobSnapshot, runId: string, next: 'succeeded' | 'failed' | 'aborted', payload: unknown): Promise<JobSnapshot> {
    const id = eventId();
    return this.mutate(
      jobId,
      () => this.deps.jobs.finalize({ ...this.params(jobId, current), state: next, eventId: id, payload }),
      (fresh) => state(fresh.state) === next
        && fresh.currentRun?.runId === runId
        // The finalization event atomically advances this sequence; event replay/chunking is Slice 4.
        && (typeof current.lastSequence !== 'number' || fresh.lastSequence === current.lastSequence + 1),
    );
  }
  private async compensate(jobId: string, current: JobSnapshot | undefined, run?: GjcWorkerRun, payload: unknown = { kind: 'admission_failed' }): Promise<void> {
    const failures: unknown[] = [];
    if (run) {
      try { await this.deps.supervisor.abort(run.abortHandle); } catch (error) { failures.push(error); }
      try { await run.completion; } catch (error) { failures.push(error); }
    }
    if (current && !terminal.has(state(current.state))) {
      try { await this.deps.jobs.finalize({ ...this.params(jobId, current), state: 'failed', eventId: eventId(), payload }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Failed to compensate job admission.');
  }
  private writer(jobId: string, current: JobSnapshot, runId: string, writer: GjcWorkerWriter, onFailure: (error: unknown) => void): GjcWorkerWriter {
    return { ...writer,
      send: (payload) => { void this.deps.jobs.appendEvent({ ...this.params(jobId, current), eventId: eventId(), payload }).then(() => { this.deps.broadcast?.(jobId, payload); writer.send(payload); }, onFailure); },
      setSessionId: (providerSessionId) => { void this.deps.jobs.bindProviderSession({ ...this.params(jobId, current), runId, providerSessionId }).then(() => writer.setSessionId?.(providerSessionId), onFailure); },
    };
  }
  private attachCompletion(jobId: string, run: GjcWorkerRun): Promise<void> {
    return run.completion.then(
      () => this.serial(jobId, async () => {
        const fresh = snapshot(await this.deps.jobs.get({ jobId }));
        if (terminal.has(state(fresh.state))) return;
        try {
          await this.finalize(jobId, fresh, fresh.currentRun?.runId ?? (() => { throw new Error('Job has no current run.'); })(), 'succeeded', { kind: 'completed' });
        } catch (error) {
          try { await this.compensate(jobId, fresh, run, { kind: 'finalize_failed', error: error instanceof Error ? error.message : 'Finalization failed.' }); } catch (compensationError) { throw new AggregateError([error, compensationError], 'Job completion finalization and compensation failed.'); }
          throw error;
        }
      }),
      async (error) => {
        await this.serial(jobId, async () => {
          const fresh = snapshot(await this.deps.jobs.get({ jobId }));
          if (terminal.has(state(fresh.state))) return;
          try {
          await this.finalize(jobId, fresh, fresh.currentRun?.runId ?? (() => { throw new Error('Job has no current run.'); })(), 'failed', { kind: 'failed', error: error instanceof Error ? error.message : 'Worker failed.' });
          } catch (finalizeError) {
            try { await this.compensate(jobId, fresh, run, { kind: 'finalize_failed', error: finalizeError instanceof Error ? finalizeError.message : 'Finalization failed.' }); } catch (compensationError) { throw new AggregateError([finalizeError, compensationError], 'Job completion finalization and compensation failed.'); }
            throw finalizeError;
          }
        });
        throw error;
      },
    );
  }
  private handle(jobId: string, runId: string, current: JobSnapshot, run: GjcWorkerRun, completion: Promise<void>): JobRunHandle { return { jobId, runId, state: current.state, started: run.started, completion, abortHandle: run.abortHandle }; }

  async start(projectRoot: string, message: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    if ((options.provider ?? 'gjc') !== 'gjc') throw new Error('Only the gjc provider is supported.');
    const suffix = this.createId().replace(/[^a-z0-9]/giu, '').toLowerCase().slice(-12); const jobId = options.jobId ?? `job-${suffix}`; const branch = `job/${jobId}`; const path = join(projectRoot, '.gjc-worktrees', jobId);
    return this.serial(jobId, async () => {
      let current: JobSnapshot | undefined; let run: GjcWorkerRun | undefined;
      try {
        current = await this.mutate(jobId, () => this.deps.jobs.reserve({ jobId, provider: 'gjc', owner: this.owner, cap: options.cap ?? 4 }), (fresh) => state(fresh.state) !== 'waiting');
        // Waiting jobs remain durable for a future dispatcher; this admission intentionally rejects rather than reporting false success.
        if (state(current.state) === 'waiting') throw new GjcCapacityExhaustedError(jobId);
        const git = this.git(projectRoot);
        let created: { worktreeId: string; path: string };
        try {
          created = createdWorktree(await git.create({ jobId, path, branch }));
        } catch (error) {
          created = worktreeAtPath(await git.list({}), path) ?? (() => { throw error; })();
        }
        current = await this.mutate(jobId, () => this.deps.jobs.prepare({ ...this.params(jobId, current!), worktreeId: created.worktreeId, branch }), (fresh) => fresh.worktreeId === created.worktreeId);
        const runId = `run-${this.createId()}`;
        current = await this.mutate(jobId, () => this.deps.jobs.admit({ ...this.params(jobId, current!), runId, appSessionId: options.appSessionId }), (fresh) => fresh.currentRun?.runId === runId || state(fresh.state) === 'queued');
        current = await this.mutate(jobId, () => this.deps.jobs.markDispatching({ ...this.params(jobId, current!), runId }), (fresh) => Boolean(fresh.dispatchCheckpoint));
        this.activeRuns.set(jobId, runId);
        const persistenceFailure = (error: unknown) => { void this.serial(jobId, async () => { const fresh = snapshot(await this.deps.jobs.get({ jobId })); await this.compensate(jobId, fresh, run, { kind: 'persistence_failed', error: error instanceof Error ? error.message : 'Persistence failed.' }); }); };
        run = this.deps.supervisor.spawnRun({ runId, appSessionId: options.appSessionId, message, options: { ...options, cwd: created.path }, writer: this.writer(jobId, current!, runId, options.writer, persistenceFailure) });
        await run.started;
        current = await this.mutate(jobId, () => this.deps.jobs.transition({ ...this.params(jobId, current!), state: 'running' }), (fresh) => state(fresh.state) === 'running');
        const completion = this.attachCompletion(jobId, run);
        return this.handle(jobId, runId, current!, run, completion);
      } catch (error) {
        if (error instanceof GjcCapacityExhaustedError) throw error;
        try { await this.compensate(jobId, current, run, { kind: 'admission_failed', error: error instanceof Error ? error.message : 'Admission failed.' }); } catch (compensationError) { throw new AggregateError([error, compensationError], 'Job admission and compensation failed.'); }
        throw error;
      }
    });
  }

  async resume(jobId: string, options: JobOrchestratorOptions): Promise<JobRunHandle> {
    return this.serial(jobId, async () => {
      let current: JobSnapshot | undefined; let run: GjcWorkerRun | undefined;
      try {
        current = snapshot(await this.deps.jobs.get({ jobId }));
        if (state(current.state) !== 'interrupted' || !current.worktreeId || !current.branch) throw new Error('Only interrupted jobs with a worktree can be resumed.');
        // worktreeId is <canonical repository root>/.gjc-worktrees/<jobId>; native worktree.list must use that repository root.
        const git = this.git(dirname(dirname(current.worktreeId))); const path = worktreePath(await git.list({}), current.worktreeId);
        if (!path) throw new Error('Stored worktree is no longer available.');
        await git.status({ jobId, branch: current.branch, path });
        const runId = `run-${this.createId()}`; const providerSessionId = options.providerSessionId ?? current.currentRun?.providerSessionId;
        try {
          current = await this.mutate(jobId, () => this.deps.jobs.readmit({ jobId, owner: this.owner, cap: options.cap ?? 4, runId, appSessionId: options.appSessionId }), (fresh) => fresh.currentRun?.runId === runId || state(fresh.state) === 'queued');
        } catch (error) {
          if (error instanceof GjcJobsClientError && error.code === 'capacity_exhausted') {
            throw new GjcCapacityExhaustedError(jobId);
          }
          throw error;
        }
        if (state(current.state) === 'waiting') throw new GjcCapacityExhaustedError(jobId);
        if (!providerSessionId && options.dispatched !== false) throw new Error('Cannot safely resume a dispatched run without a provider session.');
        current = await this.mutate(jobId, () => this.deps.jobs.markDispatching({ ...this.params(jobId, current!), runId }), (fresh) => Boolean(fresh.dispatchCheckpoint));
        this.activeRuns.set(jobId, runId);
        const persistenceFailure = (error: unknown) => { void this.serial(jobId, async () => { const fresh = snapshot(await this.deps.jobs.get({ jobId })); await this.compensate(jobId, fresh, run, { kind: 'persistence_failed', error: error instanceof Error ? error.message : 'Persistence failed.' }); }); };
        run = this.deps.supervisor.spawnRun({ runId, appSessionId: options.appSessionId, message: options.message ?? '', options: { ...options, sessionId: providerSessionId, cwd: path }, writer: this.writer(jobId, current!, runId, options.writer, persistenceFailure) });
        await run.started;
        current = await this.mutate(jobId, () => this.deps.jobs.transition({ ...this.params(jobId, current!), state: 'running' }), (fresh) => state(fresh.state) === 'running');
        const completion = this.attachCompletion(jobId, run);
        return this.handle(jobId, runId, current!, run, completion);
      } catch (error) {
        if (error instanceof GjcCapacityExhaustedError) throw error;
        try { await this.compensate(jobId, current, run, { kind: 'admission_failed', error: error instanceof Error ? error.message : 'Admission failed.' }); } catch (compensationError) { throw new AggregateError([error, compensationError], 'Job admission and compensation failed.'); }
        throw error;
      }
    });
  }

  async abort(jobId: string): Promise<boolean> { return this.serial(jobId, async () => { let current = snapshot(await this.deps.jobs.get({ jobId })); const currentState = state(current.state); if (terminal.has(currentState)) return false; if (currentState === 'reserved' || currentState === 'queued' || currentState === 'dispatching') { await this.deps.jobs.finalize({ ...this.params(jobId, current), state: 'aborted', eventId: eventId(), payload: { kind: 'aborted_before_start' } }); return true; } if (currentState !== 'running' && currentState !== 'aborting') return false; if (currentState === 'running') current = snapshot(await this.deps.jobs.transition({ ...this.params(jobId, current), state: 'aborting' })); if (!await this.deps.supervisor.abort(this.activeRuns.get(jobId) ?? jobId)) return false; const fresh = snapshot(await this.deps.jobs.get({ jobId })); if (!terminal.has(state(fresh.state))) await this.deps.jobs.finalize({ ...this.params(jobId, fresh), state: 'aborted', eventId: eventId(), payload: { kind: 'aborted' } }); return true; }); }
  reconcile(): Promise<unknown> { return this.deps.jobs.reconcile({}); }
}
type ProductionOrchestrator = JobOrchestrator & { close(): void }; let production: ProductionOrchestrator | undefined;
export function getProductionJobOrchestrator(): ProductionOrchestrator { if (production) return production; const database = join(dirname(getDatabasePath()), 'jobs.sqlite3'); const jobs = new GjcJobsClient({ database }); const clients = new Map<string, GjcGitClient>(); const gitForProject = (projectRoot: string): GjcGitClient => { if (!projectRoot) throw new Error('GJC resume requires a project root.'); if (!existsSync(join(projectRoot, '.git'))) throw new Error(`GJC project root is not a Git repository: ${projectRoot}`); let client = clients.get(projectRoot); if (!client) { if (clients.size >= 32) { const oldest = clients.entries().next().value as [string, GjcGitClient] | undefined; if (oldest) { oldest[1].close(); clients.delete(oldest[0]); } } client = new GjcGitClient({ workdir: projectRoot }); clients.set(projectRoot, client); } return client; }; const orchestrator = new JobOrchestrator({ jobs, gitForProject, supervisor: getGjcWorkerSupervisor() }) as ProductionOrchestrator; orchestrator.close = () => { jobs.close(); for (const client of clients.values()) client.close(); clients.clear(); production = undefined; }; void mkdir(dirname(database), { recursive: true }).catch(() => {}); production = orchestrator; return orchestrator; }
