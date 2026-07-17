import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { GjcJobsClient } from './gjc-jobs-client.js';
import type { GjcNativeSpawn } from './gjc-git-client.js';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stdin = new EventEmitter() as EventEmitter & { writes: string[]; write(data: string): boolean; end(): void };
  constructor() { super(); this.stdin.writes = []; this.stdin.write = (data) => (this.stdin.writes.push(data), true); this.stdin.end = () => {}; }
  kill(): boolean { return true; }
  frame(value: unknown): void { this.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)); }
}
function fake(children: FakeChild[]): GjcNativeSpawn { return ((_command, _args, _options) => { const child = new FakeChild(); children.push(child); return child; }) as GjcNativeSpawn; }
const idAt = (child: FakeChild, position: number) => JSON.parse(child.stdin.writes[position]!).id as string;

test('jobs proves readiness through job.list probe and dispatches wrappers', async () => {
  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children) });
  const pending = client.admit({ id: 'run' }); const child = children[0]!;
  assert.equal(JSON.parse(child.stdin.writes[0]!).method, 'job.list');
  child.frame({ protocolVersion: 1, id: idAt(child, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(child.stdin.writes[1]!).method, 'job.admit');
  child.frame({ protocolVersion: 1, id: idAt(child, 1), ok: true, result: { admitted: true } });
  assert.deepEqual(await pending, { admitted: true }); client.close();
});

test('jobs rejects requests on EOF, restarts, and does not replay admission', async () => {
  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children), restartDelayMs: 1 });
  const pending = client.transition({ id: 'run' }); const first = children[0]!;
  first.frame({ protocolVersion: 1, id: idAt(first, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve)); first.emit('close');
  await assert.rejects(pending); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 2); assert.equal(children[1]!.stdin.writes.length, 1); assert.equal(JSON.parse(children[1]!.stdin.writes[0]!).method, 'job.list'); client.close();
});

test('jobs rejects malformed frames and aggregate overflow', async () => {
  const malformedChildren: FakeChild[] = []; const malformed = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(malformedChildren), restartDelayMs: 1 });
  const malformedRequest = malformed.list(); malformedChildren[0]!.stdout.emit('data', Buffer.from('{bad}\n'));
  await assert.rejects(malformedRequest); malformed.close();

  const children: FakeChild[] = []; const client = new GjcJobsClient({ database: '/jobs.sqlite', spawn: fake(children), restartDelayMs: 1, aggregateLimitBytes: 1 });
  const pending = client.list(); const child = children[0]!;
  child.frame({ protocolVersion: 1, id: idAt(child, 0), ok: true, result: [] });
  await new Promise((resolve) => setImmediate(resolve));
  child.frame({ protocolVersion: 1, kind: 'item', id: idAt(child, 1), sequence: 0, item: { too: 'large' } });
  await assert.rejects(pending); client.close();
});
