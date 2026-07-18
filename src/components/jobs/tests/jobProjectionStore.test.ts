import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSessionStore, type SessionStore } from '../../../stores/useSessionStore';

function store(): SessionStore { let value: SessionStore | undefined; function Harness() { value = useSessionStore(); return null; } renderToStaticMarkup(createElement(Harness)); assert.ok(value); return value; }
const event = (sequence: number, eventId = `event-${sequence}`) => ({ sequence, eventId, payload: { sequence } });

test('job projection applies a contiguous replay once and does not jump to an ack cursor', () => {
  const value = store();
  value.setActiveJob('job-1');
  value.applyJobSubscribed('job-1', { jobId: 'job-1', provider: 'gjc', state: 'running', lastSequence: 99 });
  assert.equal(value.getJobCursor('job-1'), 0);
  assert.equal(value.applyJobReplayChunk('job-1', [event(1), event(2)]), true);
  assert.equal(value.applyJobReplayChunk('job-1', [event(1), event(2)]), true);
  assert.equal(value.getJobSlot('job-1').orderedTail.length, 2);
});
test('job terminal events atomically update the snapshot state and cursor without ack jumps', () => {
  const value = store();
  value.applyJobSubscribed('job-1', { jobId: 'job-1', provider: 'gjc', state: 'running', lastSequence: 9 });
  assert.equal(value.applyJobReplayChunk('job-1', [{
    sequence: 1,
    eventId: 'run-terminal:run-1',
    payload: { schemaVersion: 1, kind: 'job_terminal', runId: 'run-1', outcome: 'succeeded', jobState: 'succeeded', reason: 'completed' },
  }]), true);
  const slot = value.getJobSlot('job-1');
  assert.equal(slot.snapshot?.state, 'succeeded');
  assert.equal(slot.snapshot?.lastSequence, 9);
  assert.equal(slot.lastAppliedSequence, 1);
  assert.equal(value.applyJobReplayChunk('job-1', [{
    sequence: 1,
    eventId: 'run-terminal:run-1',
    payload: { schemaVersion: 1, kind: 'job_terminal', runId: 'run-1', outcome: 'succeeded', jobState: 'succeeded', reason: 'completed' },
  }]), true);
  assert.equal(slot.orderedTail.length, 1);
});

test('job projection refuses gaps and conflicting sequence ids', () => {
  const value = store();
  value.setActiveJob('job-1');
  assert.equal(value.applyJobLiveEvent('job-1', event(2)), false);
  assert.equal(value.getJobCursor('job-1'), 0);
  assert.equal(value.applyJobLiveEvent('job-1', event(1)), true);
  assert.equal(value.applyJobLiveEvent('job-1', event(1, 'other')), false);
  assert.equal(value.getJobSlot('job-1').error, 'protocol_violation');
});

test('job projections clear at an auth boundary', () => {
  const value = store();
  value.setActiveJob('job-1');
  value.applyJobLiveEvent('job-1', event(1));
  value.clearJobs();
  assert.equal(value.getJobCursor('job-1'), 0);
});
