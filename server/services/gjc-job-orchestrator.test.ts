import assert from 'node:assert/strict';
import test from 'node:test';

import { GjcCapacityExhaustedError, JobOrchestrator, type JobAuthority, type GitWorktrees, type JobSupervisor } from './gjc-job-orchestrator.js';
import type { GjcWorkerOutcome } from '../gjc-worker-client.js';

type Snap = { jobId: string; state: string; lease: { owner: string; generation: number }; worktreeId?: string; repositoryRoot?: string; branch?: string; currentRun?: { runId: string; appSessionId: string }; dispatchCheckpoint?: { runId: string } };
class Jobs implements JobAuthority {
  calls: Array<[string, Record<string, unknown>]> = []; state: Snap = { jobId: '', state: 'reserved', lease: { owner: 'owner', generation: 1 } };
  private call(name: string, params: Record<string, unknown>): Promise<unknown> { this.calls.push([name, params]); return Promise.resolve(this.state); }
  reserve(p: Record<string, unknown>) { this.state = { ...this.state, jobId: String(p.jobId), state: 'reserved', lease: { owner: String(p.owner), generation: 1 } }; return this.call('reserve', p); }
  prepare(p: Record<string, unknown>) { this.state = { ...this.state, worktreeId: String(p.worktreeId), repositoryRoot: String(p.repositoryRoot), branch: String(p.branch) }; return this.call('prepare', p); }
  admit(p: Record<string, unknown>) { this.state = { ...this.state, state: 'queued', currentRun: { runId: String(p.runId), appSessionId: String(p.appSessionId) } }; return this.call('admit', p); }
  readmit(p: Record<string, unknown>) { this.state = { ...this.state, state: 'queued', lease: { owner: String(p.owner), generation: 2 }, currentRun: { runId: String(p.runId), appSessionId: String(p.appSessionId) } }; return this.call('readmit', p); }
  transition(p: Record<string, unknown>) { if (['succeeded', 'failed', 'aborted', 'interrupted'].includes(String(p.state))) return Promise.reject(new Error('invalid_transition')); this.state = { ...this.state, state: String(p.state) }; return this.call('transition', p); }
  markDispatching(p: Record<string, unknown>) { this.state = { ...this.state, state: 'queued', dispatchCheckpoint: { runId: String(p.runId) } }; return this.call('markDispatching', p); }
  finalize(p: Record<string, unknown>) { this.state = { ...this.state, state: String(p.state), lease: { owner: '', generation: 0 } }; return this.call('finalize', p); }
  cancelAdmission(p: Record<string, unknown>) { this.state = { ...this.state, state: 'failed', lease: { owner: '', generation: 0 } }; return this.call('cancelAdmission', p); }
  appendEvent(p: Record<string, unknown>) { return this.call('appendEvent', p); }
  get(p: Record<string, unknown>) { return this.call('get', p); }
  reconcile(p: Record<string, unknown> = {}) { return this.call('reconcile', p); }
  bindProviderSession(p: Record<string, unknown>) { return this.call('bindProviderSession', p); }
  reserveStart(p: Record<string, unknown>) { return this.reserve(p); }
  turnAdmit(p: Record<string, unknown>) { return this.admit(p); }
  runFinalize(p: Record<string, unknown>) { return this.finalize({ ...p, state: p.terminalRunState }); }
  bindingResolve(p: Record<string, unknown>) { return Promise.resolve({ jobId: this.state.jobId, state: this.state.state, providerSessionId: 'provider-1', ...p }); }
  bindingRelease(p: Record<string, unknown>) { return this.call('bindingRelease', p); }
  interruptForShutdown() { this.state = { ...this.state, state: 'interrupted' }; return this.call('interruptForShutdown', {}); }
}
class Git implements GitWorktrees { calls: string[] = []; async create() { this.calls.push('create'); return { worktree: { worktreeId: '/project/.gjc-worktrees/job-abc', jobId: 'job-abc', path: '/project/.gjc-worktrees/job-abc', branch: 'job/job-abc', head: 'abc' } }; } async list() { this.calls.push('list'); return { items: [{ worktreeId: '/project/.gjc-worktrees/job-abc', path: '/project/.gjc-worktrees/job-abc' }] }; } async status() { this.calls.push('status'); return { branch: 'job/abc' }; } }
class Supervisor implements JobSupervisor { input?: Parameters<JobSupervisor['spawnRun']>[0]; aborted?: string; spawnRun(input: Parameters<JobSupervisor['spawnRun']>[0]) { this.input = input; return { started: Promise.resolve(), completion: new Promise<void>(() => {}), abortHandle: input.runId }; } async abort(id: string) { this.aborted = id; return true; } }
const options = { appSessionId: 'app-1', writer: { send() {} } };
const stopCompletionTimeoutMs = 5;

test('start reserves before creating a worktree, admits caller-owned run id, then runs it', async () => {
  const jobs = new Jobs(); const git = new Git(); const supervisor = new Supervisor();
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  const result = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  assert.equal(result.jobId, 'job-abc');
  assert.deepEqual(jobs.calls.map(([name]) => name), ['reserve', 'prepare', 'admit', 'markDispatching', 'transition']);
  assert.deepEqual(git.calls, ['create']);
  assert.equal(supervisor.input?.runId, 'run-abc');
  assert.equal(supervisor.input?.appSessionId, 'app-1');
  let completed = false;
  void result.completion.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
});
test('completion resolves only after durable finalization succeeds', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  let finalize!: () => void; const finalizeGate = new Promise<void>((resolve) => { finalize = resolve; });
  jobs.finalize = async (p) => { jobs.calls.push(['finalize', p]); await finalizeGate; jobs.state = { ...jobs.state, state: String(p.state) }; return jobs.state; };
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }), abort: async () => true };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  const run = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  let completed = false; void run.completion.then(() => { completed = true; });
  settle(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(jobs.calls.at(-1)?.[0], 'finalize');
  finalize(); await run.completion; assert.equal(jobs.state.state, 'succeeded');
});
test('completion read-back accepts a committed success when the finalize response is lost', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  jobs.finalize = async (p) => {
    jobs.calls.push(['finalize', p]);
    jobs.state = { ...jobs.state, state: String(p.state) };
    throw new Error('finalize response lost');
  };
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }), abort: async () => true };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', 'hello', options);
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
  assert.deepEqual(jobs.calls.slice(-2).map(([name]) => name), ['finalize', 'get']);
});
test('pre-run admission failure uses cancelAdmission instead of forbidden terminal transition', async () => {
  const jobs = new Jobs(); const git = new Git(); git.create = async () => { throw new Error('worktree failed'); };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor: new Supervisor(), owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /worktree failed/);
  assert.equal(jobs.state.state, 'failed');
  assert.equal(jobs.calls.at(-1)?.[0], 'cancelAdmission');
  assert.equal(jobs.calls.some(([name, params]) => name === 'transition' && params.state === 'failed'), false);
});
test('surfaces an unconfirmed cancelAdmission failure instead of hiding a fenced lease', async () => {
  const jobs = new Jobs(); const git = new Git();
  git.create = async () => { throw new Error('worktree failed'); };
  jobs.cancelAdmission = async (p) => {
    jobs.calls.push(['cancelAdmission', p]);
    throw new Error('cancel storage failed');
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor: new Supervisor(), owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /cancel storage failed/);
  assert.equal(jobs.state.state, 'reserved');
});

test('worker failure finalizes durable state and rejects completion', async () => {
  const jobs = new Jobs(); const git = new Git();
  const workerError = new Error('worker exploded');
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion: Promise.reject(workerError), abortHandle: input.runId }), abort: async () => true };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', 'hello', options);
  await assert.rejects(run.completion, /worker exploded/);
  assert.equal(jobs.state.state, 'failed');
});

test('durability failure latches before completion and cannot be reported as success', async () => {
  const jobs = new Jobs(); const git = new Git();
  let complete!: () => void;
  const workerCompletion = new Promise<void>((resolve) => { complete = resolve; });
  const supervisor: JobSupervisor = {
    spawnRun: (input) => {
      input.writer.send({ kind: 'delta' });
      return { started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId };
    },
    abort: async () => true,
  };
  jobs.appendEvent = async (p) => { jobs.calls.push(['appendEvent', p]); throw new Error('event disk failed'); };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', 'hello', options);
  complete();
  await assert.rejects(run.completion, /event disk failed/);
  assert.equal(jobs.state.state, 'failed');
});

test('a never-dispatched start failure cancels admission instead of leaving a queued lease', async () => {
  const jobs = new Jobs(); const git = new Git();
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.reject(new Error('start failed')), completion: new Promise<void>(() => {}), outcome: Promise.resolve('not_started'), abortHandle: input.runId }), abort: async () => 'unconfirmed' };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /start failed/);
  assert.equal(jobs.state.state, 'failed');
  assert.equal(jobs.calls.some(([name]) => name === 'cancelAdmission'), true);
});
test('forced worker generation termination permits failed finalization after abort refusal', async () => {
  const jobs = new Jobs(); const git = new Git();
  let terminated = false;
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.reject(new Error('start failed')), completion: new Promise<void>(() => {}), abortHandle: input.runId }),
    abort: async () => false,
    terminate: async () => (terminated = true),
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /start failed/);
  assert.equal(terminated, true);
  assert.equal(jobs.state.state, 'failed');
});

test('capacity admission rejects while leaving the durable waiting job for a future dispatcher', async () => {
  const jobs = new Jobs(); jobs.reserve = async (p) => { jobs.calls.push(['reserve', p]); jobs.state = { ...jobs.state, jobId: String(p.jobId), state: 'Waiting' }; return jobs.state; };
  const git = new Git(); const supervisor = new Supervisor(); const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), (error: unknown) => error instanceof GjcCapacityExhaustedError && error.jobId === 'job-abc');
  assert.equal(jobs.state.state, 'Waiting'); assert.deepEqual(git.calls, []); assert.equal(supervisor.input, undefined);
});

test('resume derives the repository root from its stored worktree and never creates one', async () => {
  const jobs = new Jobs(); jobs.state = { jobId: 'job-abc', state: 'Interrupted', lease: { owner: 'old', generation: 1 }, worktreeId: '/project/.gjc-worktrees/job-abc', repositoryRoot: '/project', branch: 'job/job-abc' };
  const git = new Git(); const supervisor = new Supervisor(); let requestedRoot: string | undefined;
  const orchestrator = new JobOrchestrator({ jobs, gitForProject: (root) => (requestedRoot = root, git), supervisor, owner: 'owner', createId: () => 'next' });
  await orchestrator.resume('job-abc', 'app-1', 'resume', options);
  assert.equal(requestedRoot, '/project'); assert.deepEqual(git.calls, ['list', 'status']); assert.equal(supervisor.input?.options?.sessionId, 'provider-1'); assert.equal(supervisor.input?.options?.cwd, '/project/.gjc-worktrees/job-abc');
});

test('an abort acknowledgement without terminal completion does not finalize the durable lease', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }),
    abort: async () => 'aborted',
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  const run = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  assert.equal(await orchestrator.abort(run.jobId), false); assert.equal(jobs.state.state, 'aborting'); assert.equal(jobs.calls.at(-1)?.[0], 'transition');
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
});
test('a completion after an unacknowledged abort finalizes Aborting as succeeded', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }),
    abort: async () => false,
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  const run = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  assert.equal(await orchestrator.abort(run.jobId), false);
  assert.equal(jobs.state.state, 'aborting');
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
  assert.equal(jobs.calls.at(-1)?.[0], 'finalize');
});
test('resolveBinding reads the durable app-session binding', async () => {
  const jobs = new Jobs();
  jobs.state = { jobId: 'job-abc', state: 'Interrupted', lease: { owner: 'owner', generation: 1 } };
  const orchestrator = new JobOrchestrator({ jobs, git: new Git(), supervisor: new Supervisor() });

  const binding = await orchestrator.resolveBinding('gjc', 'app-1');
  assert.equal(binding?.jobId, 'job-abc');
  assert.equal(binding?.state, 'Interrupted');
  assert.equal(binding?.providerSessionId, 'provider-1');
});
test('a running transition failure compensates before the worker outcome settles', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settleCompletion!: () => void; const workerCompletion = new Promise<void>((resolve) => { settleCompletion = resolve; });
  let settleOutcome!: (outcome: GjcWorkerOutcome) => void; const workerOutcome = new Promise<GjcWorkerOutcome>((resolve) => { settleOutcome = resolve; });
  let aborted = false;
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({
      started: Promise.resolve(),
      completion: workerCompletion,
      outcome: workerOutcome,
      phase: () => 'request_issued',
      abortHandle: input.runId,
    }),
    abort: async () => (aborted = true, 'aborted'),
    terminate: async () => 'reaped',
  };
  jobs.transition = async () => { throw new Error('running transition failed'); };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /running transition failed/);
  assert.equal(aborted, true);
  assert.equal(jobs.state.state, 'failed');
  settleOutcome('reaped');
  settleCompletion();
  await Promise.all([workerOutcome, workerCompletion]);
});
test('an early healthy authority notification waits for prior cleanup and reconciles once', async () => {
  const jobs = new Jobs(); const git = new Git();
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
  const completions: Array<() => void> = [];
  const supervisor: JobSupervisor = {
    spawnRun: (input) => {
      let settle!: () => void;
      const completion = new Promise<void>((resolve) => { settle = resolve; });
      completions.push(settle);
      return { started: Promise.resolve(), completion, abortHandle: input.runId };
    },
    abort: async () => { await abortGate; return 'aborted'; },
    terminate: async () => 'reaped',
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  const firstRun = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  const down = orchestrator.authorityHealth(false);
  const up = orchestrator.authorityHealth(true);
  releaseAbort();
  await Promise.all([down, up]);
  assert.equal(jobs.calls.filter(([name]) => name === 'reconcile').length, 1);
  const secondRun = await orchestrator.start('gjc', 'app-2', '/project', 'hello', options);
  completions.forEach((settle) => settle());
  await Promise.all([firstRun.completion, secondRun.completion]);
  assert.equal(jobs.state.state, 'succeeded');
});