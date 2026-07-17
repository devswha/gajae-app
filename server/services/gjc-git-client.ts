import { randomUUID } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_AGGREGATE_BYTES = 64 * 1024;
const FAILURE = 'GJC native client is unavailable.';

type Child = {
  stdin: { write(data: string): boolean; end(): void; on?(event: string, listener: (...args: unknown[]) => void): unknown };
  stdout: { on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown };
  stderr?: { on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown };
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
};
export type GjcNativeSpawn = (command: string, args: string[], options: { detached: false; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean }) => Child;
export type GjcNativeClientOptions = {
  corePath?: string; spawn?: GjcNativeSpawn; platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv;
  compiled?: boolean; readyTimeoutMs?: number; restartDelayMs?: number; maxRestartDelayMs?: number; aggregateLimitBytes?: number;
};
type Pending = { resolve(value: unknown): void; reject(error: Error): void; items: unknown[]; chunks: Buffer[]; bytes: number; nextSequence: number };

/** Protocol v1 NDJSON process owner. Failed requests are deliberately never replayed. */
export class GjcNativeClient {
  private readonly options: Required<Pick<GjcNativeClientOptions, 'spawn' | 'platform' | 'environment' | 'readyTimeoutMs' | 'restartDelayMs' | 'maxRestartDelayMs' | 'aggregateLimitBytes'>> & Pick<GjcNativeClientOptions, 'corePath' | 'compiled'>;
  private child?: Child;
  private input = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private starting?: Promise<void>;
  private ready = false;
  private closed = false;
  private restarting = false;
  private backoff: number;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;

  constructor(private readonly command: 'git' | 'jobs', options: GjcNativeClientOptions = {}, private readonly launchArgs?: string[]) {
    this.options = { spawn: options.spawn ?? spawnChild as unknown as GjcNativeSpawn, platform: options.platform ?? process.platform, environment: options.environment ?? process.env, readyTimeoutMs: options.readyTimeoutMs ?? 5_000, restartDelayMs: options.restartDelayMs ?? 50, maxRestartDelayMs: options.maxRestartDelayMs ?? 1_000, aggregateLimitBytes: options.aggregateLimitBytes ?? MAX_AGGREGATE_BYTES, corePath: options.corePath, compiled: options.compiled };
    this.backoff = this.options.restartDelayMs;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.start();
    if (!this.ready || !this.child) throw new Error(FAILURE);
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject, items: [], chunks: [], bytes: 0, nextSequence: 0 }));
    try {
      this.child.stdin.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', id, method, params })}\n`);
    } catch {
      this.rejectPending(id, new Error(FAILURE));
    }
    return result;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(FAILURE));
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    const executable = this.options.platform === 'win32' ? 'gajae-core.exe' : 'gajae-core';
    const compiled = this.options.compiled ?? !import.meta.url.endsWith('.ts');
    const corePath = this.options.corePath ?? fileURLToPath(new URL(compiled ? `../../../dist-native/${executable}` : `../../dist-native/${executable}`, import.meta.url));
    try {
      const args = this.launchArgs ?? (this.command === 'git' ? ['git', '--workdir', process.cwd()] : ['jobs', '--database', '']);
      this.child = this.options.spawn(corePath, args, { detached: false, env: this.options.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child.stdout.on('data', (chunk) => this.onData(chunk));
      this.child.stdin.on?.('error', () => this.failed());
      this.child.on('error', () => this.failed()); this.child.on('exit', () => this.failed()); this.child.on('close', () => this.failed());
      if (this.command === 'jobs') this.probe();
      const timer = setTimeout(() => { if (!this.ready) this.failed(); }, this.options.readyTimeoutMs);
      timer.unref?.();
    } catch { this.failed(); }
    return this.starting;
  }


  private probe(): void {
    const id = randomUUID();
    this.pending.set(id, { resolve: () => this.markReady(), reject: () => {}, items: [], chunks: [], bytes: 0, nextSequence: 0 });
    try { this.child?.stdin.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', id, method: 'job.list', params: { limit: 1 } })}\n`); } catch { this.failed(); }
  }

  private onData(chunk: Buffer | Uint8Array): void {
    if (this.closed) return;
    this.input = Buffer.concat([this.input, Buffer.from(chunk)]);
    while (true) {
      const newline = this.input.indexOf(10); if (newline < 0) break;
      const raw = this.input.subarray(0, newline); this.input = this.input.subarray(newline + 1);
      if (raw.length > MAX_FRAME_BYTES) return this.failed();
      let frame: unknown;
      try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r$/u, '')); } catch { return this.failed(); }
      this.decode(frame);
      if (this.closed) return;
    }
    if (this.input.length > MAX_FRAME_BYTES) this.failed();
  }

  private decode(frame: unknown): void {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return this.failed();
    const value = frame as Record<string, unknown>;
    if (value.protocolVersion !== 1) return this.failed();
    if (this.command === 'git' && value.kind === 'ready') { if (this.ready) return this.failed(); this.markReady(); return; }
    if (typeof value.id !== 'string') return this.failed();
    const pending = this.pending.get(value.id); if (!pending) return this.failed();
    if (value.kind === 'item' || value.kind === 'chunk') {
      if (!this.ready || !Number.isSafeInteger(value.sequence) || value.sequence !== pending.nextSequence || (value.kind === 'chunk' && (value.encoding !== 'base64' || typeof value.data !== 'string'))) return this.failed();
      let data: Buffer;
      try { data = value.kind === 'chunk' ? Buffer.from(value.data as string, 'base64') : Buffer.from(JSON.stringify(value.item)); } catch { return this.failed(); }
      pending.bytes += data.length; if (pending.bytes > this.options.aggregateLimitBytes) return this.failed();
      pending.nextSequence += 1;
      if (value.kind === 'chunk') pending.chunks.push(data); else pending.items.push(value.item);
      return;
    }
    if (value.kind !== 'response' && this.command === 'git') return this.failed();
    if (typeof value.ok !== 'boolean') return this.failed();
    this.pending.delete(value.id);
    if (value.ok) { pending.resolve(value.result === undefined ? { items: pending.items, chunks: pending.chunks.length ? Buffer.concat(pending.chunks) : undefined } : value.result); if (this.command === 'jobs' && !this.ready) this.markReady(); }
    else pending.reject(new Error(typeof (value.error as Record<string, unknown> | undefined)?.code === 'string' ? (value.error as Record<string, unknown>).code as string : FAILURE));
  }

  private markReady(): void { if (!this.ready) { this.ready = true; this.backoff = this.options.restartDelayMs; this.readyResolve?.(); } }
  private rejectPending(id: string, error: Error): void { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); pending.reject(error); } }
  private failed(): void {
    if (this.closed || this.restarting) return;
    this.ready = false; this.readyReject?.(new Error(FAILURE)); this.starting = undefined;
    for (const [id] of this.pending) this.rejectPending(id, new Error(FAILURE));
    this.child = undefined; this.input = Buffer.alloc(0); this.restarting = true;
    const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, this.options.maxRestartDelayMs);
    const timer = setTimeout(() => { this.restarting = false; void this.start().catch(() => {}); }, delay); timer.unref?.();
  }
  close(): void { this.closed = true; this.readyReject?.(new Error(FAILURE)); for (const [id] of this.pending) this.rejectPending(id, new Error(FAILURE)); try { this.child?.stdin.end(); } catch {} }
}

export type GjcGitClientOptions = GjcNativeClientOptions & { workdir: string };
export class GjcGitClient extends GjcNativeClient {
  constructor(private readonly gitOptions: GjcGitClientOptions) { super('git', gitOptions, ['git', '--workdir', gitOptions.workdir]); }
  override start(): Promise<void> { return super.start(); }
  create(params: Record<string, unknown>): Promise<unknown> { return this.request('worktree.create', params); }
  list(params: Record<string, unknown> = {}): Promise<unknown> { return this.request('worktree.list', params); }
  status(params: Record<string, unknown> = {}): Promise<unknown> { return this.request('worktree.status', params); }
  diff(params: Record<string, unknown> = {}): Promise<unknown> { return this.request('worktree.diff', params); }
  prune(params: Record<string, unknown> = {}): Promise<unknown> { return this.request('worktree.prune', params); }
}
