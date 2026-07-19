import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { JobListItem } from '../types';
import { useJobsController } from '../hooks/useJobsController';

import JobStatusBadge from './JobStatusBadge';
const relativeCreatedAt = (createdAt?: string) => {
  if (!createdAt) return undefined;
  const timestamp = new Date(createdAt.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};

const projectNameFromRepositoryRoot = (repositoryRoot?: string) => (
  repositoryRoot?.split(/[\\/]/).filter(Boolean).pop()
);

export default function JobSidebarSection({ jobs: suppliedJobs }: { jobs?: JobListItem[] }) {
  const location = useLocation();
  const { jobs: loadedJobs, refresh } = useJobsController();
  const hasSuppliedJobs = Boolean(suppliedJobs);
  // The controller owns the mount fetch; this effect only re-syncs badges on
  // subsequent navigation (e.g. returning from a finished job detail), and
  // not at all when the caller supplies an authoritative list.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (hasSuppliedJobs) return;
    void refresh();
  }, [location.pathname, refresh, hasSuppliedJobs]);
  const jobs = suppliedJobs ?? loadedJobs as JobListItem[];
  return <section className="px-3 py-2"><div className="mb-1 text-xs font-semibold text-muted-foreground">JOBS</div>{jobs.map(job => {
    const id = job.jobId ?? job.id;
    const projectName = projectNameFromRepositoryRoot(job.repositoryRoot);
    const createdAt = relativeCreatedAt(job.createdAt);
    return id ? <Link className="flex items-center justify-between rounded p-2 hover:bg-muted" key={id} to={`/jobs/${id}`}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{id}</span>
        {projectName && <span className="block truncate text-xs text-muted-foreground">{projectName}</span>}
        {job.prompt && <span className="block truncate text-xs text-muted-foreground" title={job.prompt}>{job.prompt}</span>}
        {createdAt && <span className="block text-xs text-muted-foreground">{createdAt}</span>}
      </span>
      <JobStatusBadge state={job.state} />
    </Link> : null;
  })}<Link className="block rounded p-2 text-sm hover:bg-muted" to="/jobs/new">New job</Link></section>;
}
