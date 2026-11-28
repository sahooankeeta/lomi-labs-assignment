import type { VersionStatus, VersionSummaryDto } from '@lomi/shared';

/**
 * Options for the version switcher, in input order (newest first). The value is the
 * version number as a string, as Mantine's Select needs.
 */
export function versionOptions(
  versions: Pick<VersionSummaryDto, 'versionNo' | 'status'>[],
  currentVersionNo: number,
): { value: string; label: string }[] {
  return versions.map((v) => ({
    value: String(v.versionNo),
    label: `v${v.versionNo} · ${v.status}${v.versionNo === currentVersionNo ? ' (current)' : ''}`,
  }));
}

/**
 * Like `versionOptions`, but while the versions list has not loaded (`undefined`) it offers
 * one `v<n>` option for the shown version, so the Select never renders blank.
 */
export function versionOptionsOrFallback(
  versions: Pick<VersionSummaryDto, 'versionNo' | 'status'>[] | undefined,
  shownVersionNo: number,
  currentVersionNo: number,
): { value: string; label: string }[] {
  if (versions) return versionOptions(versions, currentVersionNo);
  return [{ value: String(shownVersionNo), label: `v${shownVersionNo}` }];
}

/** One row of the delete-confirmation list. */
export interface DeleteSummaryLine {
  label: string;
  status: VersionStatus;
  createdAt: string;
  current: boolean;
}

/**
 * What the delete modal tells the user will go: a count heading plus one line per version,
 * newest first. An empty list (still loading, or the list call failed) gets a generic heading,
 * because the server deletes every version regardless of what the UI managed to show.
 */
export function deleteSummary(
  versions: VersionSummaryDto[],
  currentVersionNo: number,
): { heading: string; lines: DeleteSummaryLine[] } {
  if (versions.length === 0) return { heading: 'All versions will be deleted.', lines: [] };
  const lines = [...versions]
    .sort((a, b) => b.versionNo - a.versionNo)
    .map((v) => ({
      label: `v${v.versionNo}`,
      status: v.status,
      createdAt: v.createdAt,
      current: v.versionNo === currentVersionNo,
    }));
  const n = lines.length;
  return { heading: `${n} ${n === 1 ? 'version' : 'versions'} will be deleted:`, lines };
}
