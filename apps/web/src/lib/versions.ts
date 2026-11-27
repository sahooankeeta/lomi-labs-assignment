import type { VersionSummaryDto } from '@lomi/shared';

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
