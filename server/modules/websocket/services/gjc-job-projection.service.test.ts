import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { clampByteBudget, GjcJobProjectionService } from './gjc-job-projection.service.js';

type Event = { eventId: string; sequence: number; payload: unknown };
type Authority = { get: (params: { jobId: string }) => Promise<unknown>; replayEvents: (params: { jobId: string; after: number; byteBudget: number }) => Promise<unknown> };

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly frames: Record<string, any>[] = [];
  send(raw: string): void { this.frames.push(JSON.parse(raw)); }
}

const event = (sequence: number, eventId = `event-${sequence}`): Event => ({ eventId, sequence, payload: { sequence } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const frame = (socket: FakeSocket, kind: string) => socket.frames.filter(item => item.kind === kind);
const subscriptionId = (socket: FakeSocket) => frame(socket, 'gjc_job_subscribed').at(-1)!.subscriptionId as string;
const subscribe = async (service: GjcJobProjectionService, socket: FakeSocket, cursor = 0) => {
  await service.handle(socket as any, { type: 'gjc.job.subscribe', jobId: 'job-a', cursor });
  return subscriptionId(socket);
};
const replay = (service: GjcJobProjectionService, socket: FakeSocket, id: string, after: number, byteBudget?: number) => service.handle(socket as any, { type: 'gjc.job.replay', jobId: 'job-a', subscriptionId: id, after, byteBudget });

test('arms before watermark read and flushes a live event that arrives during it', async () => {
  const snapshot = deferred<any>();
  const service = new GjcJobProjectionService({ get: () => snapshot.promise, replayEvents: async () => ({ events: [event(1)] }) });
  const socket = new FakeSocket();
  const pending = service.handle(socket as any, { type: 'gjc.job.subscribe', jobId: 'job-a', cursor: 0 });
  service.publish('job-a', event(2));
  snapshot.resolve({ lastSequence: 1 });
  await pending;
  await replay(service, socket, subscriptionId(socket), 0);
  assert.deepEqual(frame(socket, 'gjc_job_event').map(item => item.sequence), [2]);
});

test('replay watermark excludes concurrent appends and emits every sequence once in order', async () => {
  let service!: GjcJobProjectionService;
  const calls: any[] = [];
  const authority: Authority = {
    get: async () => ({ lastSequence: 3 }),
    replayEvents: async params => {
      calls.push(params);
      if (params.after === 0) { service.publish('job-a', event(4)); return { events: [event(1)] }; }
      return { events: [event(2), event(3)], nextCursor: 999 };
    },
  };
  service = new GjcJobProjectionService(authority);
  const socket = new FakeSocket();
  const id = await subscribe(service, socket);
  await replay(service, socket, id, 0, 1);
  await replay(service, socket, id, 1, 999999);
  assert.deepEqual(calls.map(item => item.byteBudget), [4096, 49152]);
  assert.deepEqual(frame(socket, 'gjc_job_replay_chunk').map(item => [item.events.map((value: Event) => value.sequence), item.nextCursor, item.done]), [[[1], 1, false], [[2, 3], null, true]]);
  assert.deepEqual(frame(socket, 'gjc_job_event').map(item => item.sequence), [4]);
});

test('done replay chunk precedes live flush and discards buffered watermark events', async () => {
  const service = new GjcJobProjectionService({ get: async () => ({ lastSequence: 2 }), replayEvents: async () => ({ events: [event(1), event(2)] }) });
  const socket = new FakeSocket();
  const id = await subscribe(service, socket);
  service.publish('job-a', event(2));
  service.publish('job-a', event(3));
  await replay(service, socket, id, 0);
  assert.deepEqual(socket.frames.map(item => item.kind), ['gjc_job_subscribed', 'gjc_job_replay_chunk', 'gjc_job_event']);
  assert.deepEqual(frame(socket, 'gjc_job_event').map(item => item.sequence), [3]);
});

test('duplicate callback is ignored while conflicting event identity terminates only that subscription', async () => {
  const service = new GjcJobProjectionService({ get: async () => ({ lastSequence: 0 }), replayEvents: async () => ({ events: [] }) });
  const first = new FakeSocket(); const second = new FakeSocket();
  const firstId = await subscribe(service, first);
  await service.handle(second as any, { type: 'gjc.job.subscribe', jobId: 'job-b', cursor: 0 });
  const secondId = subscriptionId(second);
  await replay(service, first, firstId, 0);
  await service.handle(second as any, { type: 'gjc.job.replay', jobId: 'job-b', subscriptionId: secondId, after: 0 });
  service.publish('job-a', event(1)); service.publish('job-a', event(1)); service.publish('job-a', event(1, 'conflict'));
  assert.deepEqual(frame(first, 'gjc_job_event').map(item => item.sequence), [1]);
  assert.equal(frame(first, 'gjc_job_error').at(-1)?.code, 'protocol_violation');
  assert.equal(frame(second, 'gjc_job_error').length, 0);
  assert.equal((service as any).bySocket.get(second).size, 1);
});

test('rejects cursor ahead of the watermark', async () => {
  const service = new GjcJobProjectionService({ get: async () => ({ lastSequence: 2 }), replayEvents: async () => ({ events: [] }) });
  const socket = new FakeSocket();
  await service.handle(socket as any, { type: 'gjc.job.subscribe', jobId: 'job-a', cursor: 3 });
  assert.equal(frame(socket, 'gjc_job_error').at(-1)?.code, 'cursor_ahead');
});

test('closes only the overflowing replay buffer so durable replay can recover', async () => {
  const service = new GjcJobProjectionService({ get: async () => ({ lastSequence: 5001 }), replayEvents: async () => ({ events: [] }) });
  const socket = new FakeSocket();
  await subscribe(service, socket);
  for (let sequence = 1; sequence <= 5001; sequence++) service.publish('job-a', event(sequence));
  assert.equal(frame(socket, 'gjc_job_error').at(-1)?.code, 'buffer_overflow');
  assert.equal((service as any).bySocket.get(socket).size, 0);
});

test('times out an unavailable replay using the injected timeout', async () => {
  const never = deferred<any>();
  const service = new GjcJobProjectionService({ get: async () => ({ lastSequence: 1 }), replayEvents: () => never.promise }, 5);
  const socket = new FakeSocket();
  const id = await subscribe(service, socket);
  void replay(service, socket, id, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(frame(socket, 'gjc_job_error').at(-1), { protocolVersion: 1, kind: 'gjc_job_error', code: 'authority_unavailable', retryable: true, message: 'authority_unavailable' });
});

test('socket close removes all child subscriptions and their buffered state', async () => {
  const service = new GjcJobProjectionService({ get: async () => ({ lastSequence: 1 }), replayEvents: async () => ({ events: [event(1)] }) });
  const socket = new FakeSocket();
  await subscribe(service, socket);
  socket.emit('close');
  assert.equal((service as any).bySocket.has(socket), false);
  service.publish('job-a', event(1));
  assert.equal(frame(socket, 'gjc_job_event').length, 0);
});

test('authority failure is isolated to GJC handling and marked retryable', async () => {
  const service = new GjcJobProjectionService({ get: async () => { throw new Error('down'); }, replayEvents: async () => ({}) });
  const socket = new FakeSocket();
  assert.equal(await service.handle(socket as any, { type: 'legacy.event' }), false);
  await service.handle(socket as any, { type: 'gjc.job.subscribe', jobId: 'job-a' });
  assert.deepEqual(frame(socket, 'gjc_job_error').at(-1), { protocolVersion: 1, kind: 'gjc_job_error', code: 'authority_unavailable', retryable: true, message: 'authority_unavailable' });
});

test('projection byte budget clamps to the protocol bounds', () => {
  assert.equal(clampByteBudget(undefined), 4096);
  assert.equal(clampByteBudget(1), 4096);
  assert.equal(clampByteBudget(49153), 49152);
  assert.equal(clampByteBudget(8192), 8192);
});
