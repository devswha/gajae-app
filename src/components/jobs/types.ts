import type { JobProjectionEvent, JobSnapshot } from '../../../shared/gjc-job-projection-protocol';

export type JobListItem = {
  jobId?: string;
  id?: string;
  state?: JobSnapshot['state'];
  repositoryRoot?: string;
  createdAt?: string;
  prompt?: string | null;
};

export type JobViewSlot = {
  snapshot: JobSnapshot | null;
  events: JobProjectionEvent[];
  cursor: number;
  error: string | null;
};
