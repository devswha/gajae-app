import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import JobSidebarSection from '../view/JobSidebarSection';

const renderSidebar = () => renderToStaticMarkup(createElement(
  MemoryRouter,
  null,
  createElement(JobSidebarSection, {
    jobs: [
      { jobId: 'job-with-root', state: 'running', repositoryRoot: '/Users/example/project-with-root/' },
      { jobId: 'job-without-root', state: 'ready' },
    ],
  }),
));

test('job rows render repository project names only when supplied', () => {
  const html = renderSidebar();

  assert.ok(html.includes('job-with-root'), 'job id renders');
  assert.ok(html.includes('project-with-root'), 'repository basename renders');
  assert.ok(html.includes('job-without-root'), 'job without repository root renders');
  assert.equal((html.match(/text-xs text-muted-foreground/g) ?? []).length, 1, 'only rooted job has a project line');
});

test('new job link renders', () => {
  const html = renderSidebar();

  assert.ok(html.includes('href="/jobs/new"'), 'new job route renders');
  assert.ok(html.includes('New job'), 'new job label renders');
});
