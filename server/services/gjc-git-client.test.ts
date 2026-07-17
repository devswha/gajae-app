import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { GjcGitClient, type GjcNativeSpawn } from './gjc-git-client.js';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stdin = new EventEmitter() as EventEmitter & { writes: string[]; write(data: string): boolean; end(): void };
  constructor() { super(); this.stdin.writes = []; this.stdin.write = (data) => (this.stdin.writes.push(data), true); this.stdin.end = () => {}; }
  kill(): boolean { return true; }
  emitFrame(frame: unknown): void { this.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`)); }
}
function spawn(children: FakeChild[]): GjcNativeSpawn { return ((_command, _args, _options) => { const child = new FakeChild(); children.push(child); return child; }) as GjcNativeSpawn; }
function requestId(child: FakeChild, index = -1): string { return JSON.parse(child.stdin.writes.at(index)!).id; }

test('git waits for ready, parses split frames, and stages stream frames', async () => {
  const children: FakeChild[] = []; const client = new GjcGitClient({ workdir: '/repo', spawn: spawn(children) });
  const pending = client.list(); const child = children[0]!;
  child.stdout.emit('data', Buffer.from('{"protocolVersion":1,"kind":"rea'));
  child.stdout.emit('data', Buffer.from('dy"}\n'));
  await new Promise((resolve) => setImmediate(resolve));
  const id = requestId(child);
  child.emitFrame({ protocolVersion: 1, kind: 'item', id, sequence: 0, item: { path: 'a' } });
  child.emitFrame({ protocolVersion: 1, kind: 'response', id, ok: true, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true }); client.close();
});

test('git rejects malformed and oversized frames', async () => {
  const children: FakeChild[] = []; const client = new GjcGitClient({ workdir: '/repo', spawn: spawn(children), restartDelayMs: 1 });
  const pending = client.list(); children[0]!.stdout.emit('data', Buffer.from('bad\n'));
  await assert.rejects(pending); client.close();
  const next: FakeChild[] = []; const oversized = new GjcGitClient({ workdir: '/repo', spawn: spawn(next), restartDelayMs: 1 });
  const rejected = oversized.list(); next[0]!.stdout.emit('data', Buffer.alloc(64 * 1024 + 1, 65));
  await assert.rejects(rejected); oversized.close();
});

test('git EOF restarts and never replays mutations', async () => {
  const children: FakeChild[] = []; const client = new GjcGitClient({ workdir: '/repo', spawn: spawn(children), restartDelayMs: 1 });
  const pending = client.create({ branch: 'x' }); const first = children[0]!; first.emitFrame({ protocolVersion: 1, kind: 'ready' });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(first.stdin.writes.length, 1);
  first.emit('exit', 1); await assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(children.length, 2); assert.equal(children[1]!.stdin.writes.length, 0); client.close();
});
