import { useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { JobGitDiffResponse } from '../../../../shared/gjc-job-projection-protocol';
import GitDiffViewer from '../../git-panel/view/shared/GitDiffViewer';

type DiffResponse = JobGitDiffResponse;

export default function JobGitChanges({ jobId, revision }: { jobId: string; revision?: number | string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Request generation: only the newest refresh may paint (an older slow
  // response must not overwrite a newer diff).
  const generationRef = useRef(0);
  // Once the user curates the commit selection, refreshes must not undo it:
  // keep the intersection with the new path set and leave newly discovered
  // paths unselected. Before any manual toggle, everything stays selected.
  const userTouchedSelectionRef = useRef(false);
  useEffect(() => { userTouchedSelectionRef.current = false; }, [jobId]);

  useEffect(() => {
    const generation = ++generationRef.current;
    void api.gjcJobs.diff(jobId).then(async (response) => {
      const body = await response.json() as DiffResponse;
      if (!response.ok) throw new Error('Unable to load changes');
      const nextPaths = Array.isArray(body.paths) ? body.paths.filter((path): path is string => typeof path === 'string') : [];
      if (generation !== generationRef.current) return;
      setDiff(typeof body.text === 'string' ? body.text : '');
      setPaths(nextPaths);
      setSelectedPaths((current) => userTouchedSelectionRef.current
        ? current.filter((path) => nextPaths.includes(path))
        : nextPaths);
      setError(null);
    }).catch((cause: unknown) => {
      if (generation !== generationRef.current) return;
      setError(cause instanceof Error ? cause.message : 'Unable to load changes');
    });
  }, [jobId, revision]);

  const togglePath = (path: string) => {
    userTouchedSelectionRef.current = true;
    setSelectedPaths((current) => current.includes(path) ? current.filter((value) => value !== path) : [...current, path]);
  };
  const commit = async () => {
    const response = await api.gjcJobs.commit(jobId, { message: message.trim(), paths: selectedPaths });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? body?.error ?? 'Unable to commit changes');
      return;
    }
    setMessage('');
    setError(null);
  };

  return <section className="space-y-2"><h2 className="font-semibold">Changes</h2>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="max-h-64 overflow-auto rounded border"><GitDiffViewer diff={diff} isMobile={false} wrapText /></div>
    {paths.length > 0 && <fieldset className="space-y-1"><legend className="text-sm font-medium">Files to commit</legend>{paths.map((path) => <label key={path} className="flex gap-2 text-sm"><input type="checkbox" checked={selectedPaths.includes(path)} onChange={() => togglePath(path)} />{path}</label>)}</fieldset>}
    <div className="flex gap-2"><input className="flex-1 rounded border p-2" value={message} onChange={e => setMessage(e.target.value)} placeholder="Commit message"/><button className="rounded border px-3" onClick={() => void commit()} disabled={!message.trim() || selectedPaths.length === 0}>Commit</button></div>
  </section>;
}
