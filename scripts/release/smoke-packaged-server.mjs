#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] || null;
}

function usage() {
  throw new Error('Usage: node scripts/release/smoke-packaged-server.mjs (--tauri-app <path> | --electron-app <path>) [--project-dir <path>]');
}

function request(url, { headers, method = 'GET', body, redirect = 'manual' } = {}) {
  // Force a fresh connection per request: the packaged server may close
  // keep-alive after a response, and undici socket reuse would then fail
  // with UND_ERR_SOCKET ("other side closed") on the next request.
  return fetch(url, { headers: { ...headers, connection: 'close' }, method, body, redirect });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

async function waitForHealth(baseUrl, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await request(`${baseUrl}/health`);
      const health = await response.json();
      if (response.ok && health.status === 'ok' && health.product === 'gajae-app' && health.protocolVersion === 1 && typeof health.version === 'string' && health.version) {
        return health;
      }
    } catch {
      // The sidecar has not bound its loopback port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Packaged server did not become healthy:\n${output.value}`);
}

function packagedTargets() {
  const tauriApp = option('--tauri-app');
  const electronApp = option('--electron-app');
  if ((!tauriApp && !electronApp) || (tauriApp && electronApp)) usage();

  if (tauriApp) {
    const app = path.resolve(tauriApp);
    // Tauri v2 nests bundle.resources under Contents/Resources/resources/.
    const candidates = [
      path.join(app, 'Contents', 'Resources', 'resources', 'server-payload'),
      path.join(app, 'Contents', 'Resources', 'server-payload'),
    ];
    const payload = candidates.find((candidate) => existsSync(candidate));
    if (!payload) {
      throw new Error(`Tauri server-payload not found under ${app}/Contents/Resources (checked resources/server-payload and server-payload)`);
    }
    return {
      label: 'Tauri',
      cwd: payload,
      command: path.join(payload, 'node', 'bin', 'node'),
      args: [path.join(payload, 'dist-server', 'server', 'index.js')],
      extraEnv: { DYLD_LIBRARY_PATH: path.join(payload, 'node', 'lib') },
    };
  }

  const app = path.resolve(electronApp);
  const payload = path.join(app, 'Contents', 'Resources', 'app');
  return {
    label: 'Electron',
    cwd: payload,
    command: path.join(app, 'Contents', 'MacOS', 'gajae-app'),
    args: [path.join(payload, 'dist-server', 'server', 'index.js')],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

async function smoke(target) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'gajae-packaged-smoke-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiKey = `smoke-key-${crypto.randomUUID()}`;
  const nonce = `smoke-nonce-${crypto.randomUUID()}`;
  const output = { value: '' };
  const projectDir = path.resolve(option('--project-dir') || rootDir);
  const child = spawn(target.command, target.args, {
    cwd: target.cwd,
    env: {
      ...process.env,
      ...target.extraEnv,
      DATABASE_PATH: path.join(temporaryDirectory, 'auth.db'),
      GJC_WORKER_AGENT_DIR: path.join(temporaryDirectory, 'agent'),
      GJC_DESKTOP: '1',
      GJC_DESKTOP_API_KEY: apiKey,
      GJC_DESKTOP_BOOTSTRAP_NONCE: nonce,
      HOME: temporaryDirectory,
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      SERVER_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.value += chunk; });
  child.stderr.on('data', (chunk) => { output.value += chunk; });

  try {
    const health = await waitForHealth(baseUrl, output);
    const denied = await request(`${baseUrl}/api/gjc/jobs`);
    if (denied.status !== 401) throw new Error(`Unauthenticated API status was ${denied.status}, expected 401.`);

    const bootstrap = await request(`${baseUrl}/desktop/bootstrap?nonce=${encodeURIComponent(nonce)}`);
    const cookie = bootstrap.headers.get('set-cookie');
    if (bootstrap.status !== 303 || bootstrap.headers.get('location') !== '/' || !cookie?.includes('HttpOnly') || !cookie.includes('gajae_desktop_api_key=')) {
      throw new Error('Desktop bootstrap did not produce the required HttpOnly cookie and root redirect.');
    }
    const replay = await request(`${baseUrl}/desktop/bootstrap?nonce=${encodeURIComponent(nonce)}`);
    if (replay.status !== 401) throw new Error(`Bootstrap nonce replay status was ${replay.status}, expected 401.`);

    const headers = { cookie: cookie.split(';', 1)[0], origin: baseUrl };
    const jobs = await request(`${baseUrl}/api/gjc/jobs`, { headers });
    if (jobs.status !== 200 || !Array.isArray((await jobs.json()).items)) throw new Error('Authenticated GJC job list did not return a list.');

    const create = await request(`${baseUrl}/api/gjc/jobs`, {
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
      body: JSON.stringify({ appSessionId: `smoke-${crypto.randomUUID()}`, projectPath: projectDir, message: 'packaged server smoke' }),
    });
    const job = await create.json();
    if (create.status !== 202 || typeof job.jobId !== 'string') throw new Error(`GJC job creation failed (${create.status}): ${JSON.stringify(job)}`);
    const abort = await request(`${baseUrl}/api/gjc/jobs/${encodeURIComponent(job.jobId)}/abort`, { headers, method: 'POST' });
    if (abort.status !== 202) throw new Error(`GJC job abort failed (${abort.status}).`);

    console.log(`${target.label} packaged server smoke passed: ${JSON.stringify(health)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await smoke(packagedTargets());
