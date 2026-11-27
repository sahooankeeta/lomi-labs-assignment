import type { VersionStatus } from '@lomi/shared';

/** How often the UI refetches while an extraction is in flight, in ms. */
export const POLL_MS = 2000;

/**
 * TanStack `refetchInterval` value for a set of shown statuses: poll only while
 * something is still `queued` or `extracting`, so idle pages make no requests.
 */
export function pollInterval(statuses: VersionStatus[]): number | false {
  return statuses.some((s) => s === 'queued' || s === 'extracting') ? POLL_MS : false;
}
