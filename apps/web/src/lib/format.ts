import type { ProgressDto } from '@lomi/shared';
import { ApiRequestError } from '../api';

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

/**
 * Message for a failed upload. 413 gets a fixed message because the server's body-limit
 * error can be a proxy's generic page; other API errors already carry a readable message.
 */
export function uploadErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return err.status === 413 ? 'file is larger than 20 MB' : err.message;
  }
  return 'Upload failed';
}

/**
 * Message for a file the drop zone rejected before upload, from react-dropzone's error
 * codes. It reuses the server's wording so a dropped and a submitted bad file read the same.
 */
export function dropRejectionMessage(codes: string[]): string {
  if (codes.includes('file-invalid-type')) return 'file is not a PDF';
  if (codes.includes('file-too-large')) return 'file is larger than 20 MB';
  if (codes.includes('too-many-files')) return 'drop one PDF at a time';
  return 'file was rejected';
}
