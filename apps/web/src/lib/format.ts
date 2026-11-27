import type { ProgressDto } from '@lomi/shared';

/**
 * One-line review progress, e.g. "3 need review · 2 approved". Zero counts are left
 * out; a version with no values shows an em dash.
 */
export function progressLabel(p: ProgressDto): string {
  if (p.total === 0) return '—';
  const parts: [number, string][] = [
    [p.pending, 'need review'],
    [p.approved, 'approved'],
    [p.corrected, 'corrected'],
    [p.carried_over, 'carried over'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(' · ');
}
