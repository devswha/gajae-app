import { useEffect, useState } from 'react';
import { api } from '../../../utils/api';
export default function JobGitChanges({ jobId }: { jobId: string }) {
 const [diff, setDiff] = useState(''); const [message, setMessage] = useState('');
 useEffect(() => { void api.gjcJobs.diff(jobId).then(async r => { const b = await r.json(); setDiff(b?.data?.diff ?? b?.diff ?? ''); }); }, [jobId]);
 return <section className="space-y-2"><h2 className="font-semibold">Changes</h2><pre className="max-h-64 overflow-auto rounded border p-3 text-xs">{diff}</pre><div className="flex gap-2"><input className="flex-1 rounded border p-2" value={message} onChange={e => setMessage(e.target.value)} placeholder="Commit message"/><button className="rounded border px-3" onClick={() => void api.gjcJobs.commit(jobId, { message })} disabled={!message.trim()}>Commit</button></div></section>;
}
