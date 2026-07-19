import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';

export function useJobsController() {
  const [jobs, setJobs] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Latest-request-wins: route changes can fire refreshes while an older
  // request is still in flight; a stale response must never overwrite a
  // newer list (e.g. hiding a job created between the two).
  const generationRef = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const response = await api.gjcJobs.list();
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.code || 'Unable to load jobs');
      if (generation !== generationRef.current) return;
      setJobs(Array.isArray(body?.items) ? body.items : []);
      setError(null);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(cause instanceof Error ? cause.message : 'Unable to load jobs');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { jobs, error, refresh };
}
