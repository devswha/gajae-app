import { useState } from 'react';
import type { Project } from '../../../types/app';
import { api } from '../../../utils/api';

export default function NewJobFlow({ projects, onCreated }: { projects: Project[]; onCreated: (jobId: string) => void }) {
  const [projectPath, setProjectPath] = useState(projects[0]?.fullPath ?? '');
  const [message, setMessage] = useState('');
  const [model, setModel] = useState('default');
  const [effort, setEffort] = useState('default');
  const [error, setError] = useState<string | null>(null);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await api.gjcJobs.create({ projectPath, message, model, effort, permissionMode: 'default' });
    const body = await response.json();
    const jobId = body?.data?.jobId ?? body?.jobId;
    if (!response.ok || typeof jobId !== 'string') { setError(body?.error?.code ?? 'Unable to create job'); return; }
    onCreated(jobId);
  };
  return <main className="flex flex-1 items-center justify-center p-6"><form onSubmit={create} className="w-full max-w-xl space-y-4 rounded-lg border p-5">
    <h1 className="text-lg font-semibold">New Gajae Code job</h1>
    <select className="w-full rounded border p-2" value={projectPath} onChange={e => setProjectPath(e.target.value)} required><option value="" disabled>Select a project</option>{projects.map(project => <option key={project.projectId} value={project.fullPath}>{project.displayName}</option>)}</select>
    <textarea className="min-h-32 w-full rounded border p-2" value={message} onChange={e => setMessage(e.target.value)} placeholder="Describe the work" required />
    <div className="grid grid-cols-2 gap-2"><input className="rounded border p-2" value={model} onChange={e => setModel(e.target.value)} aria-label="Model" /><select className="rounded border p-2" value={effort} onChange={e => setEffort(e.target.value)} aria-label="Effort"><option value="default">Default effort</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
    <p className="text-sm text-muted-foreground">Permission mode: default</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<button className="rounded bg-primary px-4 py-2 text-primary-foreground" type="submit">Start job</button>
  </form></main>;
}
