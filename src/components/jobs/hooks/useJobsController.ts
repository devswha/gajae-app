import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../utils/api';

export function useJobsController() {
  const [jobs, setJobs] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await api.gjcJobs.list();
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.code || 'Unable to load jobs');
      setJobs(Array.isArray(body?.items) ? body.items : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load jobs');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { jobs, error, refresh };
}
