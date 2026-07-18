import { Link } from 'react-router-dom';

import { useJobsController } from '../hooks/useJobsController';

import JobStatusBadge from './JobStatusBadge';
export default function JobSidebarSection({ jobs: suppliedJobs }: { jobs?: Array<{ jobId?: string; id?: string; state?: any }> }) {
  const { jobs: loadedJobs } = useJobsController();
  const jobs = suppliedJobs ?? loadedJobs as Array<{ jobId?: string; id?: string; state?: any }>;
  return <section className="px-3 py-2"><div className="mb-1 text-xs font-semibold text-muted-foreground">JOBS</div>{jobs.map(job => { const id = job.jobId ?? job.id; return id ? <Link className="flex items-center justify-between rounded p-2 hover:bg-muted" key={id} to={`/jobs/${id}`}><span className="truncate text-sm">{id}</span><JobStatusBadge state={job.state} /></Link> : null; })}<Link className="block rounded p-2 text-sm hover:bg-muted" to="/jobs/new">New job</Link></section>;
}
