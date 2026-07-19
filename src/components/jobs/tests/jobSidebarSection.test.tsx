import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import type { JobListItem } from '../types';
import JobSidebarSection from '../view/JobSidebarSection';

const renderSidebar = (jobs: JobListItem[] = [
  { jobId: 'job-with-root', state: 'running', repositoryRoot: '/Users/example/project-with-root/' },
  { jobId: 'job-without-root', state: 'ready' },
]) => renderToStaticMarkup(createElement(
  MemoryRouter,
  null,
  createElement(JobSidebarSection, { jobs }),
));

test('job rows render repository project names only when supplied', () => {
  const html = renderSidebar();

  assert.ok(html.includes('job-with-root'), 'job id renders');
  assert.ok(html.includes('project-with-root'), 'repository basename renders');
  assert.ok(html.includes('job-without-root'), 'job without repository root renders');
  assert.equal((html.match(/text-xs text-muted-foreground/g) ?? []).length, 1, 'only rooted job has a project line');
});

test('job rows render prompt truncation and UTC creation times', () => {
  const prompt = 'Implement the sidebar prompt preview without losing the full request';
  const createdAt = new Date(Date.now() - 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const html = renderSidebar([{ jobId: 'job-with-details', state: 'running', prompt, createdAt }]);

  assert.ok(html.includes(prompt), 'prompt renders');
  assert.ok(html.includes(`title="${prompt}"`), 'prompt title exposes the full text');
  assert.ok(html.includes('block truncate text-xs text-muted-foreground'), 'prompt uses CSS truncation');
  assert.ok(html.includes('5m ago'), 'UTC creation time renders relatively');
});

test('job rows omit invalid creation times and preserve rows without new fields', () => {
  const html = renderSidebar([
    { jobId: 'job-legacy', state: 'ready' },
    { jobId: 'job-invalid-time', state: 'ready', createdAt: 'not-a-sqlite-timestamp' },
  ]);

  assert.ok(html.includes('job-legacy'), 'legacy row renders');
  assert.ok(html.includes('job-invalid-time'), 'invalid timestamp row renders');
  assert.equal(html.includes('ago'), false, 'invalid timestamps have no relative label');
  assert.equal(html.includes('title='), false, 'missing prompts have no title');
});

test('new job link renders', () => {
  const html = renderSidebar();

  assert.ok(html.includes('href="/jobs/new"'), 'new job route renders');
  assert.ok(html.includes('New job'), 'new job label renders');
});
