import { Badge } from '@mantine/core';
import type { VersionStatus } from '@lomi/shared';

const STATUS_COLOR: Record<VersionStatus, string> = {
  queued: 'gray',
  extracting: 'blue',
  extracted: 'green',
  failed: 'red',
  superseded: 'yellow',
};

/** Badge showing a version's status, one colour per status. Shared by the list and detail pages. */
export function StatusPill({ status }: { status: VersionStatus }) {
  return <Badge color={STATUS_COLOR[status]}>{status}</Badge>;
}
