import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const probe = databasePath => new Promise((resolve, reject) => {
  const script = `
    import express from 'express';
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { apiKeysDb, closeConnection, initializeDatabase, userDb } from './server/modules/database/index.js';
    import { getProductionJobAuthority, getProductionJobOrchestrator } from './server/services/gjc-job-orchestrator.js';
    import agentRouter from './server/routes/agent.js';

    const main = async () => {
      await initializeDatabase();
      const user = userDb.createUser('gjc-agent-route-test', 'unused');
      const { apiKey } = apiKeysDb.createApiKey(Number(user.id), 'gjc-agent-route-test');
      const app = express();
      app.use(express.json());
      app.use('/api/agent', agentRouter);
      const server = createServer(app);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const authority = getProductionJobAuthority();
      await authority.list({});
      const { port } = server.address();
      const response = await fetch(\`http://127.0.0.1:\${port}/api/agent\`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ provider: 'gjc', projectPath: process.cwd(), message: 'Do not start a job.', sessionId: 42, stream: false }),
      });
      const body = await response.json();
      const authorityHealthy = Array.isArray(await authority.list({}));
      await new Promise(resolve => server.close(resolve));
      getProductionJobOrchestrator().close();
      closeConnection();
      console.log(JSON.stringify({ status: response.status, error: body.error, authorityHealthy }));
    };
    main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: databasePath, TSX_TSCONFIG_PATH: 'server/tsconfig.json' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => {
    if (code !== 0) return reject(new Error(`agent route probe failed (${code}): ${stderr}`));
    const result = stdout.trim().split('\n').at(-1);
    resolve(JSON.parse(result));
  });
});

test('POST /api/agent rejects non-string GJC session IDs without terminating the native authority', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'gjc-agent-route-'));
  try {
    const result = await probe(path.join(temporaryDirectory, 'auth.db'));
    assert.equal(result.status, 400);
    assert.match(result.error, /sessionId/u);
    assert.equal(result.authorityHealthy, true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
