import { useMemo } from 'react';

import type { JobProjectionEvent } from '../../../../shared/gjc-job-projection-protocol';

// Presentation cap only — canonical projection state (orderedTail, cursor,
// identity checks) lives untouched in the store. The tail is unbounded and
// text deltas arrive as individual durable events, so only the newest window
// is rendered; every event inside it stays discoverable via its raw details.
const DISPLAY_WINDOW = 400;

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const compactJson = (value: unknown, max = 200): string => {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

type Tone = 'default' | 'muted' | 'success' | 'error' | 'warning';

type TimelineRow = {
  key: string;
  label: string;
  tone: Tone;
  summary?: string;
  body?: string;
  bodyMuted?: boolean;
  events: JobProjectionEvent[];
};

const deltaText = (payload: UnknownRecord | null): string =>
  asText(payload?.content) || asText(payload?.text) || asText(payload?.delta);

const isTerminalPayload = (payload: UnknownRecord | null): payload is UnknownRecord =>
  Boolean(payload && typeof payload.outcome === 'string' && typeof payload.runId === 'string');

function rowFor(event: JobProjectionEvent): TimelineRow {
  const payload = asRecord(event.payload);
  const kind = asText(payload?.kind);
  const base = { key: event.eventId, events: [event] };

  if (isTerminalPayload(payload) && !kind) {
    const outcome = asText(payload.outcome);
    return {
      ...base,
      label: `Job ${outcome}`,
      tone: outcome === 'succeeded' ? 'success' : outcome === 'interrupted' || outcome === 'aborted' ? 'warning' : 'error',
      summary: asText(payload.reason) || undefined,
    };
  }
  switch (kind) {
    case 'thinking':
      return { ...base, label: 'Thinking', tone: 'muted', body: deltaText(payload), bodyMuted: true };
    case 'tool_use': {
      const name = asText(payload?.toolName) || asText(payload?.name);
      return { ...base, label: name ? `Tool · ${name}` : 'Tool call', tone: 'default', summary: compactJson(payload?.input ?? {}) };
    }
    case 'tool_result':
      return { ...base, label: 'Tool result', tone: 'muted', summary: compactJson(payload?.content ?? payload?.output ?? '') };
    case 'status': {
      if (asText(payload?.text) === 'token_budget') {
        const budget = asRecord(payload?.tokenBudget);
        const total = budget?.totalTokens;
        const cost = asRecord(budget?.cost)?.total;
        const parts = [
          typeof total === 'number' ? `${total.toLocaleString()} tokens` : null,
          typeof cost === 'number' ? `$${cost.toFixed(4)}` : null,
        ].filter(Boolean);
        return { ...base, label: 'Usage', tone: 'muted', summary: parts.join(' · ') || compactJson(payload?.tokenBudget) };
      }
      return { ...base, label: 'Status', tone: 'muted', summary: asText(payload?.text) || compactJson(payload) };
    }
    case 'permission_request':
      return { ...base, label: 'Permission requested', tone: 'warning', summary: asText(payload?.message) || compactJson(payload?.input ?? '') };
    case 'permission_cancelled':
      return { ...base, label: 'Permission cancelled', tone: 'warning' };
    case 'error':
      return { ...base, label: 'Error', tone: 'error', body: deltaText(payload) || compactJson(payload) };
    case 'complete': {
      const exitCode = payload?.exitCode;
      const clean = exitCode === 0;
      return { ...base, label: 'Run finished', tone: clean ? 'success' : 'error', summary: typeof exitCode === 'number' ? `exit ${exitCode}` : undefined };
    }
    case 'admission_failed':
      return { ...base, label: 'Admission failed', tone: 'error', summary: asText(payload?.error) };
    case 'git_commit':
      return { ...base, label: 'Commit', tone: 'success', summary: compactJson(payload) };
    case 'stream_end':
      return { ...base, label: 'Message end', tone: 'muted' };
    default:
      return { ...base, label: 'Event', tone: 'muted', summary: compactJson(event.payload) };
  }
}

function buildRows(events: JobProjectionEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let openDelta: TimelineRow | null = null;
  for (const event of events) {
    const payload = asRecord(event.payload);
    const kind = asText(payload?.kind);
    if (kind === 'stream_delta') {
      // Consecutive deltas coalesce into one assistant block. Lossless: every
      // source event (id + sequence + payload) stays listed in the raw details.
      if (!openDelta) {
        openDelta = { key: event.eventId, label: 'Assistant', tone: 'default', body: '', events: [] };
        rows.push(openDelta);
      }
      openDelta.body = (openDelta.body ?? '') + deltaText(payload);
      openDelta.events.push(event);
      continue;
    }
    if (kind === 'stream_end' && openDelta) {
      openDelta.events.push(event);
      openDelta = null;
      continue;
    }
    openDelta = null;
    rows.push(rowFor(event));
  }
  return rows;
}

const TONE_LABEL: Record<Tone, string> = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-400',
};

export default function JobTimeline({ events }: { events: JobProjectionEvent[] }) {
  const windowed = events.length > DISPLAY_WINDOW ? events.slice(-DISPLAY_WINDOW) : events;
  const elidedCount = events.length - windowed.length;
  const rows = useMemo(() => buildRows(windowed), [windowed]);

  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }
  return <ol className="space-y-2">
    {elidedCount > 0 && <li className="rounded border border-dashed p-2 text-xs text-muted-foreground">{elidedCount.toLocaleString()} earlier events not shown</li>}
    {rows.map((row) => {
      const first = row.events[0];
      const last = row.events[row.events.length - 1];
      return <li key={row.key} className="rounded border p-3 text-sm">
        <div className="flex items-baseline gap-2">
          <span className={`shrink-0 font-medium ${TONE_LABEL[row.tone]}`}>{row.label}</span>
          {row.summary && <span className="min-w-0 truncate text-muted-foreground">{row.summary}</span>}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">#{first.sequence}{row.events.length > 1 ? `–${last.sequence}` : ''}</span>
        </div>
        {row.body && <pre className={`mt-1 whitespace-pre-wrap break-words font-sans ${row.bodyMuted ? 'italic text-muted-foreground' : ''}`}>{row.body}</pre>}
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">raw ({row.events.length})</summary>
          <div className="mt-1 space-y-1">
            {row.events.map((sourceEvent) => <pre key={sourceEvent.eventId} className="overflow-x-auto rounded bg-muted/40 p-2 text-xs">{`#${sourceEvent.sequence} ${sourceEvent.eventId}\n`}{typeof sourceEvent.payload === 'string' ? sourceEvent.payload : JSON.stringify(sourceEvent.payload, null, 2)}</pre>)}
          </div>
        </details>
      </li>;
    })}
  </ol>;
}
