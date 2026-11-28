import { Badge } from '@mantine/core';
import type { VersionStatus } from '@lomi/shared';
import { palette } from '../theme';

// Pastel background per status: blue = waiting, pink = working, green = done. Text is always
// ink, so the pastel only reinforces the word and contrast stays high.
const STATUS_BG: Record<VersionStatus, string> = {
  queued: palette.sky,
  extracting: palette.blush,
  extracted: palette.sage,
  failed: palette.rose,
  superseded: palette.butter,
};

/** Pastel pill showing a version's status as text. Shared by the list, detail and delete modal. */
export function StatusPill({ status }: { status: VersionStatus }) {
  return (
    <Badge bg={STATUS_BG[status]} c={palette.ink} fw={500} size="md">
      {status}
    </Badge>
  );
}
