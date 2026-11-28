import { Group, Stack, Text, Title } from '@mantine/core';
import type { DocumentDetailDto } from '@lomi/shared';
import { Link } from 'react-router';
import { progressLabel } from '../lib/format';
import { DeleteDocumentButton } from './DeleteDocumentButton';
import { DocumentTypePill } from './DocumentTypePill';
import { ReviewRing } from './ReviewRing';
import { ReviewStatusPill } from './ReviewStatusPill';
import { StatusPill } from './StatusPill';
import { VersionBar } from './VersionBar';

/**
 * Small pill link back to the list. Always a plain link to `/` (never history), so it also
 * works when the page was opened directly. The arrow is inline SVG: no icon library.
 */
function BackToList() {
  return (
    <Link to="/" className="back-pill">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M19 12H5M11 6l-6 6 6 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      All documents
    </Link>
  );
}

interface Props {
  d: DocumentDetailDto;
  id: string;
  /** Whether the shown version is the document's current one. */
  isCurrent: boolean;
}

/**
 * The detail page's sidebar content: back link, delete, title and status pills, review
 * progress and versions. Rendered by DocumentDetail into the sidebar slot (it owns the
 * document query, so nothing is fetched twice). Blocks are slightly lighter charcoal panels;
 * the title is clamped to two lines with the full text in `title`.
 */
export function DocumentSummary({ d, id, isCurrent }: Props) {
  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <BackToList />
        <DeleteDocumentButton
          documentId={id}
          title={d.title}
          currentVersionNo={d.currentVersionNo}
        />
      </Group>
      <Stack gap={8}>
        <Title order={1} fz={22} lh={1.2} className="summary-title" title={d.title}>
          {d.title}
        </Title>
        <Group gap={6}>
          <DocumentTypePill type={d.type} />
          <Text fz="xs">v{d.version.versionNo}</Text>
          {/* Review status only for the current version; older ones show the raw status. */}
          {isCurrent ? (
            <ReviewStatusPill status={d.status} progress={d.progress} />
          ) : (
            <StatusPill status={d.status} />
          )}
          <Text fz="xs">{progressLabel(d.progress)}</Text>
        </Group>
      </Stack>
      <div className="summary-panel">
        <Text fw={600} fz="sm" mb={8}>
          Review progress
        </Text>
        <ReviewRing progress={d.progress} />
      </div>
      <div className="summary-panel">
        <VersionBar
          documentId={id}
          versionNo={d.version.versionNo}
          currentVersionNo={d.currentVersionNo}
        />
      </div>
    </Stack>
  );
}
