import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { getProductionJobOrchestrator } from '../services/gjc-job-orchestrator.js';

import router, { decodeListQuery, decodeReplayQuery, statusForGjcError } from './gjc-jobs.js';

const serve = async () => {
  const app = express();
  app.use(router);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    request: pathname => fetch(`http://127.0.0.1:${port}${pathname}`),
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
};

test('GJC jobs routes keep the authority alive across invalid and valid pagination requests', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'gjc-jobs-route-'));
  const originalDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  const server = await serve();
  try {
    assert.equal((await server.request('/jobs?cursor=invalid%20cursor')).status, 400);
    const response = await server.request('/jobs?limit=10');
    assert.equal(response.status, 200);
    assert.equal((await server.request('/jobs?cursor=MIGRATED_Job.1%3Aorigin')).status, 200);
    assert.deepEqual(await response.json(), []);
  } finally {
    await server.close();
    getProductionJobOrchestrator().close();
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('GJC jobs pagination decodes HTTP query values into the native envelope', () => {
  assert.deepEqual(decodeListQuery({ limit: '10', cursor: 'MIGRATED_Job.1:origin' }), { afterCursor: 'MIGRATED_Job.1:origin', limit: 10 });
  assert.deepEqual(decodeListQuery({ limit: '999' }), { limit: 100 });
  assert.deepEqual(decodeReplayQuery({ cursor: '12' }), { after: 12 });
});
test('GJC event replay clamps byte budgets before forwarding to native authority', () => {
  assert.deepEqual(decodeReplayQuery({ cursor: '12', byteBudget: '1' }), { after: 12, byteBudget: 4096 });
  assert.deepEqual(decodeReplayQuery({ byteBudget: '999999' }), { byteBudget: 49152 });
  assert.deepEqual(decodeReplayQuery({ byteBudget: '8192' }), { byteBudget: 8192 });
});


test('GJC jobs pagination rejects values that would violate the native envelope', () => {
  assert.throws(() => decodeListQuery({ limit: 'not-a-number' }), { code: 'invalid_request' });
  assert.throws(() => decodeListQuery({ cursor: 'invalid cursor' }), { code: 'invalid_request' });
  assert.throws(() => decodeReplayQuery({ cursor: '1.5' }), { code: 'invalid_request' });
  assert.throws(() => decodeReplayQuery({ cursor: ['1', '2'] }), { code: 'invalid_request' });
});
test('GJC event replay rejects invalid byte budgets before native authority access', () => {
  assert.throws(() => decodeReplayQuery({ byteBudget: '1.5' }), { code: 'invalid_request' });
  assert.throws(() => decodeReplayQuery({ byteBudget: ['4096', '8192'] }), { code: 'invalid_request' });
  assert.throws(() => decodeReplayQuery({ byteBudget: String(Number.MAX_SAFE_INTEGER + 1) }), { code: 'invalid_request' });
});

test('GJC jobs errors use availability, conflict, and missing-resource statuses', () => {
  const error = code => Object.assign(new Error(code), { code });
  assert.equal(statusForGjcError(error('GJC_JOB_AUTHORITY_UNAVAILABLE')), 503);
  assert.equal(statusForGjcError(error('already_exists')), 409);
  assert.equal(statusForGjcError(error('invalid_transition')), 409);
  assert.equal(statusForGjcError(error('lease_held')), 409);
  assert.equal(statusForGjcError(error('stale_lease')), 409);
  assert.equal(statusForGjcError(error('capacity_exhausted')), 409);
  assert.equal(statusForGjcError(error('not_found')), 404);
  assert.equal(statusForGjcError(error('invalid_request')), 400);
  assert.equal(statusForGjcError(error('storage_failure')), 503);
});