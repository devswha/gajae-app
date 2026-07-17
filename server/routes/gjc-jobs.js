import crypto from 'node:crypto';

import express from 'express';
import { Octokit } from '@octokit/rest';

import { githubTokensDb } from '../modules/database/index.js';
import { getProductionJobAuthority, getProductionJobOrchestrator } from '../services/gjc-job-orchestrator.js';
import { getProductionGjcJobGitService } from '../services/gjc-job-git.service.js';

const MAX_LIST_LIMIT = 100;
const MAX_SAFE_U64 = Number.MAX_SAFE_INTEGER;
const NATIVE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONFLICT_CODES = new Set(['already_exists', 'invalid_transition', 'lease_held', 'stale_lease', 'terminal_job', 'event_conflict', 'worktree_conflict', 'authority_held', 'conflict', 'capacity_exhausted']);
const router = express.Router();
const writer = { send() {} };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const invalidQuery = message => Object.assign(new Error(message), { code: 'invalid_request' });
const queryValue = (value, name) => {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value !== 'string') throw invalidQuery(`${name} must be a single query value.`);
  return value.trim();
};
const u64 = (value, name) => {
  const source = queryValue(value, name);
  if (!source) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(source)) throw invalidQuery(`${name} must be an unsigned integer.`);
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SAFE_U64) throw invalidQuery(`${name} is outside the supported range.`);
  return parsed;
};
export const decodeListQuery = query => {
  const limit = u64(query.limit, 'limit');
  if (limit === 0) throw invalidQuery('limit must be at least 1.');
  const cursor = queryValue(query.cursor, 'cursor');
  if (cursor && !NATIVE_ID.test(cursor)) throw invalidQuery('cursor is invalid.');
  return { ...(cursor ? { afterCursor: cursor } : {}), ...(limit === undefined ? {} : { limit: Math.min(limit, MAX_LIST_LIMIT) }) };
};
export const decodeReplayQuery = query => {
  const after = u64(query.cursor, 'cursor');
  return after === undefined ? {} : { after };
};
export const statusForGjcError = error => {
  const code = error?.code;
  if (code === 'GJC_JOB_AUTHORITY_UNAVAILABLE' || code === 'authority_unavailable' || code === 'authority-down' || code === 'authority_down' || /authority is unavailable/u.test(error?.message ?? '')) return 503;
  if (code === 'storage_failure') return 503;
  if (code === 'not_found') return 404;
  if (CONFLICT_CODES.has(code) || error?.name === 'GjcCapacityExhaustedError') return 409;
  return 400;
};
const fail = (res, error) => res.status(statusForGjcError(error)).json({ error: error instanceof Error ? error.message : 'GJC job request failed.', code: error?.code });
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
router.get('/jobs', async (req, res) => {
  try {
    return res.json(await getProductionJobAuthority().list(decodeListQuery(req.query)));
  } catch (error) {
    return fail(res, error);
  }
});
router.get('/jobs/:jobId', async (req, res) => { try { return res.json(await getProductionJobAuthority().get({ jobId: req.params.jobId })); } catch (error) { return fail(res, error); } });
router.get('/jobs/:jobId/events', async (req, res) => {
  try {
    return res.json(await getProductionJobAuthority().replayEvents({ jobId: req.params.jobId, ...decodeReplayQuery(req.query) }));
  } catch (error) {
    return fail(res, error);
  }
});
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
