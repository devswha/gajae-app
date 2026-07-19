import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useJobsController } from '../hooks/useJobsController';

import JobStatusBadge from './JobStatusBadge';
export default function JobSidebarSection({ jobs: suppliedJobs }: { jobs?: Array<{ jobId?: string; id?: string; state?: any }> }) {
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
  const jobs = suppliedJobs ?? loadedJobs as Array<{ jobId?: string; id?: string; state?: any }>;
  return <section className="px-3 py-2"><div className="mb-1 text-xs font-semibold text-muted-foreground">JOBS</div>{jobs.map(job => { const id = job.jobId ?? job.id; return id ? <Link className="flex items-center justify-between rounded p-2 hover:bg-muted" key={id} to={`/jobs/${id}`}><span className="truncate text-sm">{id}</span><JobStatusBadge state={job.state} /></Link> : null; })}<Link className="block rounded p-2 text-sm hover:bg-muted" to="/jobs/new">New job</Link></section>;
}
