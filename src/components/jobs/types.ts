import type { JobProjectionEvent, JobSnapshot } from '../../../shared/gjc-job-projection-protocol';

export type JobViewSlot = {
  snapshot: JobSnapshot | null;
  events: JobProjectionEvent[];
  cursor: number;
  error: string | null;
};
