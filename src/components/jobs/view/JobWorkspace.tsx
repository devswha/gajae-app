import { useEffect } from 'react';
import type { SessionStore } from '../../../stores/useSessionStore';
import { useJobProjection } from '../hooks/useJobProjection';
import JobStatusBadge from './JobStatusBadge';
import JobTimeline from './JobTimeline';
import JobGitChanges from './JobGitChanges';
import { api } from '../../../utils/api';

export default function JobWorkspace({ jobId, store }: { jobId: string; store: SessionStore }) {
  const slot = useJobProjection(jobId, store);
  useEffect(() => () => store.setActiveJob(null), [store]);
  const snapshot = slot?.snapshot;
  const state = snapshot?.state;
  const resume = () => void api.gjcJobs.resume(jobId);
  return <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5"><header className="flex items-center justify-between"><div><h1 className="font-semibold">Job {jobId}</h1><p className="text-sm text-muted-foreground">Cursor {slot?.lastAppliedSequence ?? 0}</p></div><JobStatusBadge state={state} /></header>
    {slot?.error && <p role="alert" className="text-destructive">{slot.error}</p>}
    <div className="flex gap-2">{['reserved', 'queued', 'running', 'aborting'].includes(state ?? '') && <button className="rounded border px-3 py-2" onClick={() => void api.gjcJobs.abort(jobId)}>Abort</button>}{state === 'interrupted' && snapshot?.currentRun?.appSessionId && <button className="rounded border px-3 py-2" onClick={resume}>Resume</button>}</div>
    <JobTimeline events={slot?.orderedTail ?? []} /><JobGitChanges jobId={jobId} />
  </main>;
}
