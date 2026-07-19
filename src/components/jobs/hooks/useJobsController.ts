import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';

const activeJobStates = new Set(['reserved', 'queued', 'running', 'aborting']);
export function useJobsController() {
  const [jobs, setJobs] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Latest-request-wins: route changes can fire refreshes while an older
  // request is still in flight; a stale response must never overwrite a
  // newer list (e.g. hiding a job created between the two).
  const generationRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    const generation = ++generationRef.current;
    try {
      const response = await api.gjcJobs.list();
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.code || 'Unable to load jobs');
      if (generation !== generationRef.current) return;
      if (!isMountedRef.current) return;
      const items: unknown[] = Array.isArray(body?.items) ? body.items : [];
      setJobs(items);
      setError(null);
      if (items.some((item) => (
        typeof item === 'object'
        && item !== null
        && activeJobStates.has((item as { state?: string }).state ?? '')
      ))) {
        pollTimerRef.current = setTimeout(() => {
          pollTimerRef.current = null;
          void refreshRef.current();
        }, 10_000);
      }
    } catch (cause) {
      if (generation !== generationRef.current) return;
      if (!isMountedRef.current) return;
      setError(cause instanceof Error ? cause.message : 'Unable to load jobs');
    }
  }, []);
  refreshRef.current = refresh;
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { jobs, error, refresh };
}
