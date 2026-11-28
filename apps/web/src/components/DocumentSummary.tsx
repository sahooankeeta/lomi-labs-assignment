import { Group, Stack, Text, Title } from '@mantine/core';
import type { DocumentDetailDto } from '@lomi/shared';
import { Link } from 'react-router';
import { shortDate } from '../lib/format';
import { DeleteDocumentButton } from './DeleteDocumentButton';
import { DocumentTypePill } from './DocumentTypePill';
import { NewVersionUpload } from './NewVersionUpload';
import { ReviewRing } from './ReviewRing';
import { ReviewStatusPill } from './ReviewStatusPill';
import { StatusPill } from './StatusPill';

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
 * progress and the new-version upload (the version picker is VersionTimeline in the main panel). Rendered by DocumentDetail into the sidebar slot (it owns the
 * document query, so nothing is fetched twice). Blocks are slightly lighter charcoal panels;
 * the title is clamped to two lines with the full text in `title`.
 */
export function DocumentSummary({ d, id, isCurrent }: Props) {
  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="nowrap">
        <BackToList />
        <DeleteDocumentButton
          documentId={id}
          title={d.title}
          currentVersionNo={d.currentVersionNo}
        />
      </Group>
      <Stack gap={10}>
        <Title order={1} fz={27} lh={1.2} className="summary-title" title={d.title}>
          {d.title}
        </Title>
        <Group gap={8}>
          <DocumentTypePill type={d.type} />
          <Text fz="sm">v{d.version.versionNo}</Text>
          {/* Review status only for the current version; older ones show the raw status. */}
          {isCurrent ? (
            <ReviewStatusPill status={d.status} progress={d.progress} />
          ) : (
            <StatusPill status={d.status} />
          )}
        </Group>
        {/* Upload time of the shown version (the version timeline shows only the number). */}
        <Text fz="sm" c="dimmed">
          Uploaded {shortDate(d.version.createdAt)}
        </Text>
      </Stack>
      <div className="summary-panel">
        <Text fw={600} fz="md" mb={12}>
          Review progress
        </Text>
        <ReviewRing progress={d.progress} />
      </div>
      {/* Only the current version can be replaced, so older versions get no upload. */}
      {isCurrent && (
        <div className="summary-panel">
          <NewVersionUpload documentId={id} />
        </div>
      )}
    </Stack>
  );
}
