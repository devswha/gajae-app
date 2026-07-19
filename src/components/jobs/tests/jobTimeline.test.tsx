import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import JobTimeline from '../view/JobTimeline';
import type { JobProjectionEvent } from '../../../../shared/gjc-job-projection-protocol';

const event = (sequence: number, payload: unknown): JobProjectionEvent => ({
  eventId: `evt-${sequence}`,
  sequence,
  payload,
});

test('consecutive stream deltas coalesce into one assistant row, losslessly', () => {
  const html = renderToStaticMarkup(createElement(JobTimeline, {
    events: [
      event(1, { kind: 'stream_delta', content: 'Hello ' }),
      event(2, { kind: 'stream_delta', content: 'world' }),
      event(3, { kind: 'stream_end' }),
      event(4, { kind: 'tool_use', toolName: 'write', input: { path: 'a.txt' } }),
    ],
  }));
  assert.ok(html.includes('Assistant'), 'assistant group rendered');
  assert.ok(html.includes('Hello world'), 'delta text coalesced');
  assert.ok((html.match(/Assistant/g) ?? []).length === 1, 'one group, not one row per delta');
  assert.ok(html.includes('raw (3)'), 'group raw details keep all source events incl. stream_end');
  assert.ok(html.includes('#1–3'), 'group shows its sequence range');
  assert.ok(html.includes('Tool · write'), 'tool_use renders its tool name');
  assert.ok(html.includes('evt-2'), 'each source event stays discoverable by id');
});

test('known kinds render labels; unknown and primitive payloads fall back to raw text', () => {
  const html = renderToStaticMarkup(createElement(JobTimeline, {
    events: [
      event(1, { kind: 'status', text: 'token_budget', tokenBudget: { totalTokens: 17795, cost: { total: 0.2278 } } }),
      event(2, { kind: 'error', content: 'boom' }),
      event(3, { kind: 'mystery', anything: true }),
      event(4, 'bare string payload'),
      event(5, { runId: 'run-1', outcome: 'succeeded', jobState: 'succeeded', reason: '' }),
    ],
  }));
  assert.ok(html.includes('Usage'), 'token budget renders as usage');
  assert.ok(html.includes('17,795 tokens'), 'token total formatted');
  assert.ok(html.includes('boom'), 'error content shown');
  assert.ok(html.includes('mystery'), 'unknown kind falls back to raw payload');
  assert.ok(html.includes('bare string payload'), 'primitive payload rendered as text');
  assert.ok(html.includes('Job succeeded'), 'terminal payload renders the outcome');
});

test('display window caps rendering and reports the elided count', () => {
  const events = Array.from({ length: 450 }, (_, index) => event(index + 1, { kind: 'stream_delta', content: 'x' }));
  // A non-delta event at the end keeps the tail from being one giant group.
  events.push(event(451, { kind: 'complete', exitCode: 0 }));
  const html = renderToStaticMarkup(createElement(JobTimeline, { events }));
  assert.ok(html.includes('51 earlier events not shown'), 'elided banner shows the exact count');
  assert.ok(!html.includes('evt-51 '), 'events before the window are not rendered');
  assert.ok(html.includes('Run finished'), 'newest events remain rendered');
});

test('empty timeline renders a quiet placeholder', () => {
  const html = renderToStaticMarkup(createElement(JobTimeline, { events: [] }));
  assert.ok(html.includes('No events yet.'));
});
