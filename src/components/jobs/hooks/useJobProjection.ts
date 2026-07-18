import { useEffect } from 'react';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useAuth } from '../../auth/context/AuthContext';
import type { SessionStore } from '../../../stores/useSessionStore';

export function useJobProjection(jobId: string | undefined, store: SessionStore) {
  const { registerJobSubscription } = useWebSocket();
  const { user } = useAuth();
  useEffect(() => { store.clearJobs(); }, [store, user]);
  useEffect(() => {
    if (!jobId) return;
    store.setActiveJob(jobId);
    return registerJobSubscription({
      jobId,
      getCursor: () => store.getJobCursor(jobId),
      onSubscribed: (snapshot) => store.applyJobSubscribed(jobId, snapshot),
      applyReplayChunk: (events) => store.applyJobReplayChunk(jobId, events),
      applyLiveEvent: (event) => store.applyJobLiveEvent(jobId, event),
      onError: (code) => store.setJobError(jobId, code),
    });
  }, [jobId, registerJobSubscription, store, user]);

  return jobId ? store.getJobSlot(jobId) : undefined;
}
