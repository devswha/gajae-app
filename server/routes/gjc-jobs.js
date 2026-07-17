import crypto from 'node:crypto';

import express from 'express';
import { Octokit } from '@octokit/rest';

import { githubTokensDb } from '../modules/database/index.js';
import { getProductionJobAuthority, getProductionJobOrchestrator } from '../services/gjc-job-orchestrator.js';
import { getProductionGjcJobGitService } from '../services/gjc-job-git.service.js';

const router = express.Router();
const writer = { send() {} };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const fail = (res, error) => {
  const code = error?.code;
  const status = code === 'authority_unavailable' || /authority is unavailable/u.test(error?.message ?? '') ? 503
    : code === 'not_found' ? 404
      : code === 'conflict' || code === 'capacity_exhausted' ? 409 : 400;
  return res.status(status).json({ error: error instanceof Error ? error.message : 'GJC job request failed.', code });
};
const appSession = body => text(body.appSessionId) ?? `gjc-${crypto.randomUUID()}`;
const jobResponse = (res, handle, appSessionId) => res.status(202).json({ provider: 'gjc', appSessionId, jobId: handle.jobId, runId: handle.runId });

router.post('/jobs', async (req, res) => {
  const message = text(req.body?.message); const projectPath = text(req.body?.projectPath);
  if (!message || !projectPath) return res.status(400).json({ error: 'message and projectPath are required.' });
  try { const appSessionId = appSession(req.body); const handle = await getProductionJobOrchestrator().start('gjc', appSessionId, projectPath, message, { writer, provider: 'gjc', appSessionId, model: text(req.body.model), effort: text(req.body.effort) }); return jobResponse(res, handle, appSessionId); } catch (error) { return fail(res, error); }
});
router.post('/jobs/:jobId/turns', async (req, res) => {
  const message = text(req.body?.message); const appSessionId = text(req.body?.appSessionId) ?? text(req.body?.sessionId);
  if (!message || !appSessionId) return res.status(400).json({ error: 'message and appSessionId are required.' });
  try {
    const orchestrator = getProductionJobOrchestrator();
    const bound = await orchestrator.resolveBinding('gjc', appSessionId);
    if (!bound || bound.jobId !== req.params.jobId) return res.status(409).json({ error: 'appSessionId is not bound to this job.' });
    const handle = await orchestrator.turnStart('gjc', appSessionId, message, { writer, provider: 'gjc', appSessionId, model: text(req.body.model), effort: text(req.body.effort) });
    return jobResponse(res, handle, appSessionId);
  } catch (error) { return fail(res, error); }
});
router.post('/jobs/:jobId/resume', async (req, res) => {
  const message = text(req.body?.message) ?? ''; const appSessionId = text(req.body?.appSessionId) ?? text(req.body?.sessionId);
  if (!appSessionId) return res.status(400).json({ error: 'appSessionId is required.' });
  try { const handle = await getProductionJobOrchestrator().resume(req.params.jobId, appSessionId, message, { writer, provider: 'gjc', appSessionId, model: text(req.body.model), effort: text(req.body.effort) }); return jobResponse(res, handle, appSessionId); } catch (error) { return fail(res, error); }
});
router.post('/jobs/:jobId/abort', async (req, res) => { try { return res.status(202).json({ provider: 'gjc', jobId: req.params.jobId, aborted: await getProductionJobOrchestrator().abort(req.params.jobId) }); } catch (error) { return fail(res, error); } });
router.get('/jobs', async (req, res) => { try { return res.json(await getProductionJobAuthority().list({ cursor: text(req.query.cursor), limit: text(req.query.limit) })); } catch (error) { return fail(res, error); } });
router.get('/jobs/:jobId', async (req, res) => { try { return res.json(await getProductionJobAuthority().get({ jobId: req.params.jobId })); } catch (error) { return fail(res, error); } });
router.get('/jobs/:jobId/events', async (req, res) => { try { return res.json(await getProductionJobAuthority().replayEvents({ jobId: req.params.jobId, cursor: text(req.query.cursor) })); } catch (error) { return fail(res, error); } });
router.get('/jobs/:jobId/git/status', async (req, res) => { try { return res.json(await getProductionGjcJobGitService(getProductionJobAuthority()).status(req.params.jobId)); } catch (error) { return fail(res, error); } });
router.get('/jobs/:jobId/git/diff', async (req, res) => { try { return res.json(await getProductionGjcJobGitService(getProductionJobAuthority()).diff(req.params.jobId)); } catch (error) { return fail(res, error); } });
router.post('/jobs/:jobId/git/publish', async (req, res) => { try { return res.json(await getProductionGjcJobGitService(getProductionJobAuthority()).publish(req.params.jobId)); } catch (error) { return fail(res, error); } });
router.post('/jobs/:jobId/git/pr', async (req, res) => {
  try {
    const result = await getProductionGjcJobGitService(getProductionJobAuthority()).createPullRequest(req.params.jobId, async context => {
      const match = context.remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/u);
      if (!match) throw new Error('The job remote is not a GitHub repository.');
      const token = githubTokensDb.getActiveGithubToken(req.user?.id);
      if (!token) throw new Error('GitHub token required to create a pull request.');
      const { data } = await new Octokit({ auth: token }).pulls.create({ owner: match[1], repo: match[2], head: context.branch, base: context.baseBranch, title: text(req.body?.title) ?? context.branch, body: text(req.body?.body) ?? '' });
      return { number: data.number, url: data.html_url, branch: context.branch, baseBranch: context.baseBranch };
    });
    return res.status(201).json(result);
  } catch (error) { return fail(res, error); }
});

export default router;
