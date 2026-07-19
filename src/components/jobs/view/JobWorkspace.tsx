import { useEffect, useState } from 'react';

import type { SessionStore } from '../../../stores/useSessionStore';
import { useJobProjection } from '../hooks/useJobProjection';
import { api } from '../../../utils/api';

import JobStatusBadge from './JobStatusBadge';
import JobTimeline from './JobTimeline';
import JobGitChanges from './JobGitChanges';

const ACTIVE_STATES = ['reserved', 'queued', 'running', 'aborting'];

export default function JobWorkspace({ jobId, store }: { jobId: string; store: SessionStore }) {
  const slot = useJobProjection(jobId, store);
  useEffect(() => () => store.setActiveJob(null), [store]);
  const snapshot = slot?.snapshot;
  const state = snapshot?.state;
  const isActive = ACTIVE_STATES.includes(state ?? '');

  // Git diff refresh policy (리뷰 반영): the projection cursor advances once per
  // streamed event, so it must NOT drive the diff fetch directly — that is one
  // git status+diff per text delta. Instead: a bounded 5s tick while the job is
  // active, plus one guaranteed refresh when it settles (ready/terminal).
  const [diffRevision, setDiffRevision] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setDiffRevision((revision) => revision + 1), 5000);
    return () => clearInterval(timer);
  }, [isActive]);
  useEffect(() => {
    if (state && !isActive) setDiffRevision((revision) => revision + 1);
  }, [state, isActive]);

  const [resumeError, setResumeError] = useState<string | null>(null);
  const resume = async () => {
    const appSessionId = snapshot?.currentRun?.appSessionId;
    if (!appSessionId) return;
    const response = await api.gjcJobs.resume(jobId, { appSessionId, message: '' });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setResumeError(body?.error?.message ?? body?.error ?? 'Unable to resume job');
      return;
    }
    setResumeError(null);
  };
  return <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5"><header className="flex items-center justify-between"><div><h1 className="font-semibold">Job {jobId}</h1><p className="text-sm text-muted-foreground">Cursor {slot?.lastAppliedSequence ?? 0}</p></div><JobStatusBadge state={state} /></header>
    {slot?.error && <p role="alert" className="text-destructive">{slot.error}</p>}{resumeError && <p role="alert" className="text-destructive">{resumeError}</p>}
    <div className="flex gap-2">{['reserved', 'queued', 'running', 'aborting'].includes(state ?? '') && <button className="rounded border px-3 py-2" onClick={() => void api.gjcJobs.abort(jobId)}>Abort</button>}{state === 'interrupted' && snapshot?.currentRun?.appSessionId && <button className="rounded border px-3 py-2" onClick={resume}>Resume</button>}</div>
    <JobTimeline events={slot?.orderedTail ?? []} /><JobGitChanges jobId={jobId} revision={diffRevision} />
  </main>;
}
