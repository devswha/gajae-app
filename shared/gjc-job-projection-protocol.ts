export const GJC_JOB_PROJECTION_PROTOCOL_VERSION = 1 as const;

export type JobSequence = number;
export type JobState = 'reserved' | 'queued' | 'running' | 'aborting' | 'ready' | 'succeeded' | 'failed' | 'aborted' | 'interrupted';
export type JobProjectionEvent = { eventId: string; sequence: JobSequence; payload: unknown };
export type JobSnapshot = {
  jobId: string;
  provider: 'gjc';
  state: JobState;
  lastSequence: JobSequence;
  worktreeId?: string;
  branch?: string;
  repositoryRoot?: string;
  baseCommit?: string;
  currentRun?: { runId: string; appSessionId?: string; providerSessionId?: string };
};

export type JobProjectionErrorCode = 'invalid_request' | 'not_found' | 'cursor_ahead' | 'cursor_mismatch' | 'authority_unavailable' | 'storage_failure' | 'buffer_overflow' | 'protocol_violation';
export type JobProjectionInboundFrame =
  | { protocolVersion: 1; kind: 'gjc.job.subscribe'; jobId: string; after?: JobSequence }
  | { protocolVersion: 1; kind: 'gjc.job.replay'; jobId: string; after?: JobSequence }
  | { protocolVersion: 1; kind: 'gjc.job.unsubscribe'; jobId: string };
export type JobProjectionOutboundFrame =
  | { protocolVersion: 1; kind: 'gjc_job_subscribed'; jobId: string; snapshot: JobSnapshot }
  | { protocolVersion: 1; kind: 'gjc_job_replay_chunk'; jobId: string; events: JobProjectionEvent[]; nextCursor?: JobSequence }
  | { protocolVersion: 1; kind: 'gjc_job_event'; jobId: string; event: JobProjectionEvent }
  | { protocolVersion: 1; kind: 'gjc_job_unsubscribed'; jobId: string }
  | { protocolVersion: 1; kind: 'gjc_job_error'; code: JobProjectionErrorCode };

export type JobTerminalOutcome = 'succeeded' | 'failed' | 'aborted' | 'interrupted';
export type JobTerminalPayload = {
  schemaVersion: 1;
  kind: 'job_terminal';
  runId: string;
  appSessionId?: string;
  outcome: JobTerminalOutcome;
  jobState: Extract<JobState, JobTerminalOutcome>;
  reason: string;
};

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/u;
const TERMINAL_STATES = new Set<JobTerminalOutcome>(['succeeded', 'failed', 'aborted', 'interrupted']);
const STATES = new Set<JobState>(['reserved', 'queued', 'running', 'aborting', 'ready', ...TERMINAL_STATES]);
const INBOUND_KINDS = new Set(['gjc.job.subscribe', 'gjc.job.replay', 'gjc.job.unsubscribe']);
const OUTBOUND_KINDS = new Set(['gjc_job_subscribed', 'gjc_job_replay_chunk', 'gjc_job_event', 'gjc_job_unsubscribed', 'gjc_job_error']);
const ERROR_CODES = new Set<JobProjectionErrorCode>(['invalid_request', 'not_found', 'cursor_ahead', 'cursor_mismatch', 'authority_unavailable', 'storage_failure', 'buffer_overflow', 'protocol_violation']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isJobSequence(value: unknown): value is JobSequence { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function isJobIdentifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER.test(value); }
export function isJobProjectionEvent(value: unknown): value is JobProjectionEvent {
  return object(value) && isJobIdentifier(value.eventId) && isJobSequence(value.sequence) && value.sequence >= 1 && 'payload' in value;
}
export function isJobProjectionInboundFrame(value: unknown): value is JobProjectionInboundFrame {
  return object(value) && value.protocolVersion === GJC_JOB_PROJECTION_PROTOCOL_VERSION && typeof value.kind === 'string' && INBOUND_KINDS.has(value.kind) && isJobIdentifier(value.jobId) && (value.after === undefined || isJobSequence(value.after));
}
export function isJobProjectionOutboundFrame(value: unknown): value is JobProjectionOutboundFrame {
  if (!object(value) || value.protocolVersion !== GJC_JOB_PROJECTION_PROTOCOL_VERSION || typeof value.kind !== 'string' || !OUTBOUND_KINDS.has(value.kind)) return false;
  if (value.kind === 'gjc_job_error') return typeof value.code === 'string' && ERROR_CODES.has(value.code as JobProjectionErrorCode);
  return isJobIdentifier(value.jobId);
}

function boundedReason(value: unknown): string {
  const source = typeof value === 'string' ? value : 'completed';
  return source.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 512) || 'completed';
}
export function jobTerminalEventId(runId: string): string { return `run-terminal:${runId}`; }
export function createJobTerminalPayload(input: { runId: string; appSessionId?: string | null; outcome: JobTerminalOutcome; reason?: unknown }): JobTerminalPayload {
  if (!isJobIdentifier(input.runId) || !TERMINAL_STATES.has(input.outcome)) throw new Error('Invalid terminal event input.');
  return {
    schemaVersion: 1,
    kind: 'job_terminal',
    runId: input.runId,
    ...(input.appSessionId ? { appSessionId: input.appSessionId } : {}),
    outcome: input.outcome,
    jobState: input.outcome,
    reason: boundedReason(input.reason),
  };
}
