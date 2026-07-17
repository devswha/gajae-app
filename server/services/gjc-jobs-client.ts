import { GjcNativeClient, type GjcNativeClientOptions } from './gjc-git-client.js';

export type GjcJobsClientOptions = GjcNativeClientOptions & { database: string };

/** Process owner for the durable native jobs protocol. A down client rejects new run admission. */
export class GjcJobsClient extends GjcNativeClient {
  constructor(options: GjcJobsClientOptions) { super('jobs', options, ['jobs', '--database', options.database]); }
  reserve(params: Record<string, unknown>): Promise<unknown> { return this.request('capacity.reserve', params); }
  prepare(params: Record<string, unknown>): Promise<unknown> { return this.request('job.prepare', params); }
  admit(params: Record<string, unknown>): Promise<unknown> { return this.request('job.admit', params); }
  readmit(params: Record<string, unknown>): Promise<unknown> { return this.request('job.readmit', params); }
  transition(params: Record<string, unknown>): Promise<unknown> { return this.request('job.transition', params); }
  finalize(params: Record<string, unknown>): Promise<unknown> { return this.request('job.finalize', params); }
  appendEvent(params: Record<string, unknown>): Promise<unknown> { return this.request('event.append', params); }
  replayEvents(params: Record<string, unknown>): Promise<unknown> { return this.request('event.replay', params); }
  list(params: Record<string, unknown> = {}): Promise<unknown> { return this.request('job.list', params); }
  get(params: Record<string, unknown>): Promise<unknown> { return this.request('job.get', params); }
  reconcile(params: Record<string, unknown> = {}): Promise<unknown> { return this.request('job.reconcile', params); }
  bindProviderSession(params: Record<string, unknown>): Promise<unknown> { return this.request('run.bindProviderSession', params); }
}
