import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jobFollowUpKind } from '../view/JobWorkspace';

test('a ready job with a bound session takes its next turn', () => {
  assert.equal(jobFollowUpKind('ready', 'app-1'), 'turn');
});

test('an interrupted job with a bound session resumes', () => {
  assert.equal(jobFollowUpKind('interrupted', 'app-1'), 'resume');
});

test('active and terminal states get no follow-up affordance', () => {
  for (const state of ['reserved', 'queued', 'running', 'aborting', 'succeeded', 'failed', 'aborted', undefined]) {
    assert.equal(jobFollowUpKind(state, 'app-1'), null);
  }
});

test('a missing app-session binding disables follow-up in every state', () => {
  for (const appSessionId of [undefined, null, '']) {
    assert.equal(jobFollowUpKind('ready', appSessionId), null);
    assert.equal(jobFollowUpKind('interrupted', appSessionId), null);
  }
});
