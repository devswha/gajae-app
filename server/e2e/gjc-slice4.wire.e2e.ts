import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { isJobProjectionOutboundFrame } from '../../shared/gjc-job-projection-protocol.js';
import { GjcGitClient } from '../services/gjc-git-client.js';
import { GjcJobGitService } from '../services/gjc-job-git.service.js';
import { GjcJobsClient } from '../services/gjc-jobs-client.js';
import { JobOrchestrator, type JobSupervisor } from '../services/gjc-job-orchestrator.js';
import { GjcJobProjectionService } from '../modules/websocket/services/gjc-job-projection.service.js';
import type { GjcWorkerSpawnRun } from '../gjc-worker-client.js';

const execFile = promisify(execFileCallback);
const corePath = join(process.cwd(), 'dist-native', 'gajae-core');
const git = (cwd: string, args: string[]) => execFile('git', args, { cwd });
class Supervisor implements JobSupervisor {
  runs: GjcWorkerSpawnRun[] = [];
  spawnRun(input: GjcWorkerSpawnRun) { this.runs.push(input); return { started: Promise.resolve(), completion: new Promise<void>(() => {}), abortHandle: input.runId, phase: () => 'request_issued' as const }; }
  async abort() { return 'aborted' as const; }
}
const waitFrame = (ws: WebSocket, kind: string) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), 3_000);
  ws.on('message', raw => { const frame = JSON.parse(String(raw)); if (frame.kind === kind) { clearTimeout(timer); resolve(frame); } });
});

test('wire e2e: HTTP jobs endpoints and canonical websocket projection frames', { timeout: 15_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gjc-wire-')));
  const database = join(root, '..', `${basename(root)}.jobs.sqlite3`);
  await git(root, ['init']); await git(root, ['config', 'user.email', 'e2e@test']); await git(root, ['config', 'user.name', 'E2E']);
  await writeFile(join(root, 'README.md'), 'base\n'); await git(root, ['add', 'README.md']); await git(root, ['commit', '-m', 'base']);
  const jobs = new GjcJobsClient({ database, corePath }); const client = new GjcGitClient({ workdir: root, corePath }); const supervisor = new Supervisor();
  const projection = new GjcJobProjectionService(jobs as any);
  const orchestrator = new JobOrchestrator({ jobs, supervisor, owner: 'wire-e2e', createId: () => `wire-${supervisor.runs.length + 1}`, gitForProject: () => client, broadcast: (id, event) => projection.publish(id, event) });
  const gitService = new GjcJobGitService(jobs, () => client);
  const app = express(); app.use(express.json());
  app.post('/api/gjc/jobs', async (req, res) => { try { const h = await orchestrator.start('gjc', req.body.appSessionId, req.body.projectPath, req.body.message, { provider: 'gjc', appSessionId: req.body.appSessionId, writer: { send() {} }, model: 'default', effort: 'default' }); res.status(202).json({ jobId: h.jobId, appSessionId: req.body.appSessionId }); } catch (e) { res.status(400).json({ error: String(e) }); } });
  app.post('/api/gjc/jobs/:id/resume', async (req, res) => { if (!req.body.appSessionId) return res.status(400).end(); res.status(200).json({ appSessionId: req.body.appSessionId }); });
  app.get('/api/gjc/jobs/:id/git/diff', async (req, res) => res.json(await gitService.diff(req.params.id)));
  app.post('/api/gjc/jobs/:id/git/commit', async (req, res) => res.status(201).json(await gitService.commit(req.params.id, req.body.message, req.body.paths)));
  const server = createServer(app); const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', ws => ws.on('message', raw => { const data = JSON.parse(String(raw)); void projection.handle(ws, data); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as any).port;
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); jobs.close(); client.close(); await rm(database, { force: true }); await rm(root, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const created = await request('/api/gjc/jobs', 'POST', { appSessionId: 'app-wire', projectPath: root, message: 'run' }); assert.equal(created.status, 202); const { jobId } = await created.json() as any;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await once(ws, 'open');
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId, after: 0 })); const subscribed = await waitFrame(ws, 'gjc_job_subscribed'); assert.ok(isJobProjectionOutboundFrame(subscribed)); const subscriptionId = subscribed.subscriptionId as string; assert.match(subscriptionId, /^gjc-/u);
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.replay', jobId, subscriptionId, after: 0, byteBudget: 4096 })); const replay = await waitFrame(ws, 'gjc_job_replay_chunk'); assert.ok(isJobProjectionOutboundFrame(replay)); assert.equal((replay as any).done, true);
  const livePromise = waitFrame(ws, 'gjc_job_event'); supervisor.runs[0]!.writer.send({ kind: 'wire_live' }); const live = await livePromise; assert.equal(live.event.payload.kind, 'wire_live');
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.unsubscribe', jobId, subscriptionId })); assert.ok(isJobProjectionOutboundFrame(await waitFrame(ws, 'gjc_job_unsubscribed'))); ws.terminate(); await once(ws, 'close');
  assert.equal((await request(`/api/gjc/jobs/${jobId}/resume`, 'POST', { appSessionId: 'app-wire' })).status, 200);
  const snapshot = await jobs.get({ jobId }) as any; await writeFile(join(snapshot.worktreeId, 'wire.txt'), 'managed\n'); const diff = await request(`/api/gjc/jobs/${jobId}/git/diff`); assert.equal(diff.status, 200); assert.match(JSON.stringify(await diff.json()), /wire\.txt/u);
});
