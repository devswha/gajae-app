import type { WebSocket } from 'ws';

import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

type Event = { eventId: string; sequence: number; payload: unknown };
type Authority = { get(params: { jobId: string }): Promise<any>; replayEvents(params: { jobId: string; after: number; byteBudget: number }): Promise<any> };
type Subscription = { id: string; jobId: string; watermark: number; lastSent: number; lastEventId?: string; buffer: Event[]; bufferBytes: number; timer?: NodeJS.Timeout; state: 'replay' | 'live' };
const MIN_BUDGET = 4 * 1024;
const MAX_BUDGET = 48 * 1024;
const MAX_BUFFER_EVENTS = 5000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
let nextId = 0;

export function clampByteBudget(value: unknown): number {
  const budget = typeof value === 'number' && Number.isSafeInteger(value) ? value : MIN_BUDGET;
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, budget));
}
function errorCode(error: unknown): 'authority_unavailable' | 'not_found' | 'storage_failure' {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === 'not_found' ? 'not_found' : code === 'storage_failure' ? 'storage_failure' : 'authority_unavailable';
}
function validEvent(value: unknown): value is Event {
  return Boolean(value) && typeof value === 'object' && typeof (value as Event).eventId === 'string' && Number.isSafeInteger((value as Event).sequence) && (value as Event).sequence > 0;
}
/** Durable replay is authoritative; this only bridges committed broadcasts without replay races. */
export class GjcJobProjectionService {
  private readonly bySocket = new Map<WebSocket, Map<string, Subscription>>();
  constructor(private readonly authority: Authority, private readonly replayTimeoutMs = 30_000) {}
  private send(ws: WebSocket, frame: Record<string, unknown>): void { if (ws.readyState === WS_OPEN_STATE) ws.send(JSON.stringify({ protocolVersion: 1, ...frame })); }
  private close(ws: WebSocket, sub: Subscription, code?: string, retryable = false): void {
    clearTimeout(sub.timer); this.bySocket.get(ws)?.delete(sub.id);
    if (code) this.send(ws, { kind: 'gjc_job_error', code, retryable, message: code });
  }
  attach(ws: WebSocket): void { this.bySocket.set(ws, new Map()); ws.once('close', () => this.detach(ws)); }
  detach(ws: WebSocket): void { const subs = this.bySocket.get(ws); if (!subs) return; for (const sub of subs.values()) clearTimeout(sub.timer); this.bySocket.delete(ws); }
  async handle(ws: WebSocket, data: Record<string, unknown>): Promise<boolean> {
    const type = data.type;
    if (type !== 'gjc.job.subscribe' && type !== 'gjc.job.replay' && type !== 'gjc.job.unsubscribe') return false;
    const jobId = typeof data.jobId === 'string' ? data.jobId : '';
    if (!jobId) { this.send(ws, { kind: 'gjc_job_error', code: 'invalid_request', retryable: false, message: 'Invalid job id.' }); return true; }
    const subscriptions = this.bySocket.get(ws) ?? (this.attach(ws), this.bySocket.get(ws)!);
    if (type === 'gjc.job.unsubscribe') {
      const sub = [...subscriptions.values()].find(item => item.jobId === jobId);
      if (sub) { this.close(ws, sub); this.send(ws, { kind: 'gjc_job_unsubscribed', subscriptionId: sub.id, jobId }); }
      return true;
    }
    if (type === 'gjc.job.subscribe') {
      const cursor = Number.isSafeInteger(data.cursor) && Number(data.cursor) >= 0 ? Number(data.cursor) : 0;
      const sub: Subscription = { id: `gjc-${++nextId}`, jobId, watermark: 0, lastSent: cursor, buffer: [], bufferBytes: 0, state: 'replay' };
      subscriptions.set(sub.id, sub); // Arm before authority.get: broadcasts are buffered during the watermark read.
      try {
        const snapshot = await this.authority.get({ jobId }); sub.watermark = Number(snapshot?.lastSequence ?? 0);
        if (cursor > sub.watermark) return this.close(ws, sub, 'cursor_ahead'), true;
        this.send(ws, { kind: 'gjc_job_subscribed', subscriptionId: sub.id, cursor, watermark: sub.watermark, snapshot });
      } catch (error) { this.close(ws, sub, errorCode(error), errorCode(error) === 'authority_unavailable'); }
      return true;
    }
    const subscriptionId = typeof data.subscriptionId === 'string' ? data.subscriptionId : '';
    const sub = subscriptions.get(subscriptionId);
    const after = Number.isSafeInteger(data.after) && Number(data.after) >= 0 ? Number(data.after) : -1;
    if (!sub || sub.jobId !== jobId || after < 0) { this.send(ws, { kind: 'gjc_job_error', code: 'invalid_request', retryable: false, message: 'Invalid subscription.' }); return true; }
    if (after !== sub.lastSent) { this.close(ws, sub, 'cursor_mismatch'); return true; }
    await this.replay(ws, sub, after, clampByteBudget(data.byteBudget)); return true;
  }
  private async replay(ws: WebSocket, sub: Subscription, after: number, byteBudget: number): Promise<void> {
    sub.timer = setTimeout(() => this.close(ws, sub, 'authority_unavailable', true), this.replayTimeoutMs);
    try {
      const response = await this.authority.replayEvents({ jobId: sub.jobId, after, byteBudget }); clearTimeout(sub.timer);
      const events: Event[] = Array.isArray(response?.events) ? response.events.filter(validEvent).filter((event: Event) => event.sequence > after && event.sequence <= sub.watermark) : [];
      let expected = after + 1;
      if (events.some((event: Event) => event.sequence !== expected++)) return this.close(ws, sub, 'protocol_violation');
      const last = events.at(-1)?.sequence;
      const done = !last || last >= sub.watermark;
      if (!done && !last) return this.close(ws, sub, 'protocol_violation');
      this.send(ws, { kind: 'gjc_job_replay_chunk', subscriptionId: sub.id, after, watermark: sub.watermark, events, nextCursor: done ? null : last, done });
      if (last) { sub.lastSent = last; sub.lastEventId = events.at(-1)?.eventId; }
      if (done) { sub.state = 'live'; this.flush(ws, sub); }
    } catch (error) { clearTimeout(sub.timer); this.close(ws, sub, errorCode(error), errorCode(error) === 'authority_unavailable'); }
  }
  publish(jobId: string, event: Event): void {
    if (!validEvent(event)) return;
    for (const [ws, subs] of this.bySocket) for (const sub of [...subs.values()]) if (sub.jobId === jobId) {
      if (sub.state !== 'live') { const bytes = Buffer.byteLength(JSON.stringify(event)); sub.buffer.push(event); sub.bufferBytes += bytes; if (sub.buffer.length > MAX_BUFFER_EVENTS || sub.bufferBytes > MAX_BUFFER_BYTES) this.close(ws, sub, 'buffer_overflow'); continue; }
      this.deliver(ws, sub, event);
    }
  }
  private flush(ws: WebSocket, sub: Subscription): void { const events = sub.buffer.filter(event => event.sequence > sub.watermark).sort((a, b) => a.sequence - b.sequence); sub.buffer = []; sub.bufferBytes = 0; for (const event of events) this.deliver(ws, sub, event); }
  private deliver(ws: WebSocket, sub: Subscription, event: Event): void { if (event.sequence === sub.lastSent) { if (event.eventId === sub.lastEventId) return; return this.close(ws, sub, 'protocol_violation'); } if (event.sequence < sub.lastSent) return; if (event.sequence !== sub.lastSent + 1) return this.close(ws, sub, 'protocol_violation'); sub.lastSent = event.sequence; sub.lastEventId = event.eventId; this.send(ws, { kind: 'gjc_job_event', eventId: event.eventId, sequence: event.sequence, payload: event.payload }); }
}
