import assert from 'node:assert/strict';
import test from 'node:test';
import { GjcCapacityExhaustedError, JobOrchestrator, type JobAuthority, type GitWorktrees, type JobSupervisor } from './gjc-job-orchestrator.js';

type Snap = { jobId: string; state: string; lease: { owner: string; generation: number }; worktreeId?: string; branch?: string; currentRun?: { runId: string; appSessionId: string }; dispatchCheckpoint?: { runId: string } };
class Jobs implements JobAuthority {
  calls: Array<[string, Record<string, unknown>]> = []; state: Snap = { jobId: '', state: 'Reserved', lease: { owner: 'owner', generation: 1 } };
  private call(name: string, params: Record<string, unknown>): Promise<unknown> { this.calls.push([name, params]); return Promise.resolve(this.state); }
  reserve(p: Record<string, unknown>) { this.state = { ...this.state, jobId: String(p.jobId), state: 'Reserved', lease: { owner: String(p.owner), generation: 1 } }; return this.call('reserve', p); }
  prepare(p: Record<string, unknown>) { this.state = { ...this.state, worktreeId: String(p.worktreeId), branch: String(p.branch) }; return this.call('prepare', p); }
  admit(p: Record<string, unknown>) { this.state = { ...this.state, state: 'Queued', currentRun: { runId: String(p.runId), appSessionId: String(p.appSessionId) } }; return this.call('admit', p); }
  readmit(p: Record<string, unknown>) { this.state = { ...this.state, state: 'Queued', lease: { owner: String(p.owner), generation: 2 }, currentRun: { runId: String(p.runId), appSessionId: String(p.appSessionId) } }; return this.call('readmit', p); }
  transition(p: Record<string, unknown>) { this.state = { ...this.state, state: String(p.state) }; return this.call('transition', p); }
  markDispatching(p: Record<string, unknown>) { this.state = { ...this.state, state: 'Queued', dispatchCheckpoint: { runId: String(p.runId) } }; return this.call('markDispatching', p); }
  finalize(p: Record<string, unknown>) { this.state = { ...this.state, state: String(p.state) }; return this.call('finalize', p); }
  appendEvent(p: Record<string, unknown>) { return this.call('appendEvent', p); }
  get(p: Record<string, unknown>) { return this.call('get', p); }
  reconcile(p: Record<string, unknown> = {}) { return this.call('reconcile', p); }
  bindProviderSession(p: Record<string, unknown>) { return this.call('bindProviderSession', p); }
  reserveStart(p: Record<string, unknown>) { return this.reserve(p); }
  turnAdmit(p: Record<string, unknown>) { return this.admit(p); }
  runFinalize(p: Record<string, unknown>) { return this.finalize({ ...p, state: p.terminalRunState }); }
  bindingResolve(p: Record<string, unknown>) { return Promise.resolve({ jobId: this.state.jobId, state: this.state.state, providerSessionId: 'provider-1', ...p }); }
  bindingRelease(p: Record<string, unknown>) { return this.call('bindingRelease', p); }
  interruptForShutdown() { this.state = { ...this.state, state: 'Interrupted' }; return this.call('interruptForShutdown', {}); }
}
class Git implements GitWorktrees { calls: string[] = []; async create() { this.calls.push('create'); return { worktree: { worktreeId: '/project/.gjc-worktrees/job-abc', jobId: 'job-abc', path: '/project/.gjc-worktrees/job-abc', branch: 'job/job-abc', head: 'abc' } }; } async list() { this.calls.push('list'); return { items: [{ worktreeId: '/project/.gjc-worktrees/job-abc', path: '/project/.gjc-worktrees/job-abc' }] }; } async status() { this.calls.push('status'); return { branch: 'job/abc' }; } }
class Supervisor implements JobSupervisor { input?: Parameters<JobSupervisor['spawnRun']>[0]; aborted?: string; spawnRun(input: Parameters<JobSupervisor['spawnRun']>[0]) { this.input = input; return { started: Promise.resolve(), completion: new Promise<void>(() => {}), abortHandle: input.runId }; } async abort(id: string) { this.aborted = id; return true; } }
const options = { appSessionId: 'app-1', writer: { send() {} } };

test('start reserves before creating a worktree, admits caller-owned run id, then runs it', async () => {
  const jobs = new Jobs(); const git = new Git(); const supervisor = new Supervisor();
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  const result = await orchestrator.start('/project', 'hello', options);
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
  const run = await orchestrator.start('/project', 'hello', options);
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
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('/project', 'hello', options);
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
  assert.deepEqual(jobs.calls.slice(-2).map(([name]) => name), ['finalize', 'get']);
});

test('capacity admission rejects while leaving the durable waiting job for a future dispatcher', async () => {
  const jobs = new Jobs(); jobs.reserve = async (p) => { jobs.calls.push(['reserve', p]); jobs.state = { ...jobs.state, jobId: String(p.jobId), state: 'Waiting' }; return jobs.state; };
  const git = new Git(); const supervisor = new Supervisor(); const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('/project', 'hello', options), (error: unknown) => error instanceof GjcCapacityExhaustedError && error.jobId === 'job-abc');
  assert.equal(jobs.state.state, 'Waiting'); assert.deepEqual(git.calls, []); assert.equal(supervisor.input, undefined);
});

test('resume derives the repository root from its stored worktree and never creates one', async () => {
  const jobs = new Jobs(); jobs.state = { jobId: 'job-abc', state: 'Interrupted', lease: { owner: 'old', generation: 1 }, worktreeId: '/project/.gjc-worktrees/job-abc', branch: 'job/job-abc' };
  const git = new Git(); const supervisor = new Supervisor(); let requestedRoot: string | undefined;
  const orchestrator = new JobOrchestrator({ jobs, gitForProject: (root) => (requestedRoot = root, git), supervisor, owner: 'owner', createId: () => 'next' });
  await orchestrator.resume('job-abc', { ...options, message: 'resume', providerSessionId: 'provider-1' });
  assert.equal(requestedRoot, '/project'); assert.deepEqual(git.calls, ['list', 'status']); assert.equal(supervisor.input?.options?.sessionId, 'provider-1'); assert.equal(supervisor.input?.options?.cwd, '/project/.gjc-worktrees/job-abc');
});

test('abort leaves Aborting durable when worker abort is not acknowledged', async () => {
  const jobs = new Jobs(); jobs.state = { jobId: 'job-abc', state: 'Running', lease: { owner: 'owner', generation: 1 } };
  const git = new Git(); const supervisor = new Supervisor(); supervisor.abort = async () => false;
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor });
  assert.equal(await orchestrator.abort('job-abc'), false); assert.equal(jobs.state.state, 'aborting'); assert.equal(jobs.calls.at(-1)?.[0], 'transition');
});
test('a completion after an unacknowledged abort finalizes Aborting as succeeded', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }),
    abort: async () => false,
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  const run = await orchestrator.start('/project', 'hello', options);
  assert.equal(await orchestrator.abort(run.jobId), false);
  assert.equal(jobs.state.state, 'aborting');
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
  assert.equal(jobs.calls.at(-1)?.[0], 'finalize');
});
