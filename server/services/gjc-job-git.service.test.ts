import assert from 'node:assert/strict';
import test from 'node:test';

import { GjcJobGitService } from './gjc-job-git.service.js';

test('job git status resolves only the stored managed worktree', async () => {
  const calls: Record<string, unknown>[] = [];
  const service = new GjcJobGitService(
    { get: async () => ({ jobId: 'job-a', repositoryRoot: '/repo', worktreeId: '/repo/.gjc-worktrees/job-a', branch: 'job/job-a', baseCommit: 'abc1234' }) },
    () => ({
      list: async () => ({ items: [{ worktreeId: '/repo/.gjc-worktrees/job-a', path: '/repo/.gjc-worktrees/job-a', branch: 'job/job-a' }] }),
      status: async params => { calls.push(params); return { clean: true, count: 0 }; },
    }),
  );

  assert.deepEqual(await service.status('job-a'), { clean: true, count: 0 });
  assert.deepEqual(calls, [
    { jobId: 'job-a', branch: 'job/job-a', path: '/repo/.gjc-worktrees/job-a' },
    { jobId: 'job-a', branch: 'job/job-a', path: '/repo/.gjc-worktrees/job-a' },
  ]);
});

test('job git resolution rejects a worktree moved off its stored branch', async () => {
  const service = new GjcJobGitService(
    { get: async () => ({ jobId: 'job-a', repositoryRoot: '/repo', worktreeId: '/repo/.gjc-worktrees/job-a', branch: 'job/job-a', baseCommit: 'abc1234' }) },
    () => ({ list: async () => ({ items: [{ worktreeId: '/repo/.gjc-worktrees/job-a', path: '/repo/.gjc-worktrees/job-a', branch: 'other' }] }), status: async () => ({ clean: true, count: 0 }) }),
  );

  await assert.rejects(service.status('job-a'), /no longer on the job branch/);
});
