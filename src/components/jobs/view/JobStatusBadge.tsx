import type { JobState } from '../../../../shared/gjc-job-projection-protocol';
export default function JobStatusBadge({ state }: { state: JobState | undefined }) {
  const label = state === 'interrupted' ? 'INTERRUPTED' : ['reserved', 'queued', 'running', 'aborting'].includes(state ?? '') ? 'RUN' : 'DONE';
  const color = label === 'INTERRUPTED' ? 'bg-amber-500' : label === 'RUN' ? 'bg-green-600' : 'bg-muted';
  return <span className={`rounded px-2 py-1 text-xs font-medium text-white ${color}`}>{label}</span>;
}
