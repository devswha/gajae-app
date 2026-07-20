import { useEffect, useState } from 'react';

import type { SessionStore } from '../../../stores/useSessionStore';
import { useJobProjection } from '../hooks/useJobProjection';
import { api } from '../../../utils/api';

import JobStatusBadge from './JobStatusBadge';
import JobTimeline from './JobTimeline';
import JobGitChanges from './JobGitChanges';

const ACTIVE_STATES = ['reserved', 'queued', 'running', 'aborting'];

/**
 * Which follow-up affordance an idle job gets: a `ready` job takes its next
 * turn (`/turns`), an `interrupted` job resumes (`/resume`), anything else —
 * including jobs without a durable app-session binding — gets none.
 */
export function jobFollowUpKind(state?: string, appSessionId?: string | null): 'turn' | 'resume' | null {
  if (!appSessionId) return null;
  if (state === 'ready') return 'turn';
  if (state === 'interrupted') return 'resume';
  return null;
}

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

  // Follow-up composer: a ready job (idle, including after an aborted run)
  // takes its next turn via /turns; an interrupted job resumes via /resume.
  // Both require the durable app-session binding from the snapshot.
  const appSessionId = snapshot?.currentRun?.appSessionId;
  const followUpKind = jobFollowUpKind(state, appSessionId);
  const [followUpMessage, setFollowUpMessage] = useState('');
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpPending, setFollowUpPending] = useState(false);
  const submitFollowUp = async () => {
    if (!appSessionId || !followUpKind || followUpPending) return;
    const message = followUpMessage.trim();
    if (followUpKind === 'turn' && !message) return;
    setFollowUpPending(true);
    try {
      const response = followUpKind === 'turn'
        ? await api.gjcJobs.turn(jobId, { appSessionId, message })
        : await api.gjcJobs.resume(jobId, { appSessionId, message });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFollowUpError(body?.error?.message ?? body?.error ?? 'Unable to continue job');
        return;
      }
      setFollowUpError(null);
      setFollowUpMessage('');
    } finally {
      setFollowUpPending(false);
    }
  };
  return <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5"><header className="flex items-center justify-between"><div><h1 className="font-semibold">Job {jobId}</h1><p className="text-sm text-muted-foreground">Cursor {slot?.lastAppliedSequence ?? 0}</p></div><JobStatusBadge state={state} /></header>
    {slot?.error && <p role="alert" className="text-destructive">{slot.error}</p>}{followUpError && <p role="alert" className="text-destructive">{followUpError}</p>}
    <div className="flex gap-2">{isActive && <button className="rounded border px-3 py-2" onClick={() => void api.gjcJobs.abort(jobId)}>Abort</button>}</div>
    {followUpKind && <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void submitFollowUp(); }}>
      <input className="min-w-0 flex-1 rounded border p-2" aria-label="Follow-up message" placeholder={followUpKind === 'resume' ? 'Optional message, then resume' : 'Describe the next turn'} value={followUpMessage} onChange={(event) => setFollowUpMessage(event.target.value)} />
      <button className="rounded border px-3 py-2" type="submit" disabled={followUpPending || (followUpKind === 'turn' && !followUpMessage.trim())}>{followUpKind === 'resume' ? 'Resume' : 'Send'}</button>
    </form>}
    <JobTimeline events={slot?.orderedTail ?? []} /><JobGitChanges jobId={jobId} revision={diffRevision} />
  </main>;
}
