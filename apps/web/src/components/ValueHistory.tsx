import { Alert, Blockquote, Drawer, Loader, Text, Timeline } from '@mantine/core';
import type { ReviewDto, ValueHistoryDto } from '@lomi/shared';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api';

/** One review as a line: its action, correction, note and time. */
function reviewLine(r: ReviewDto): string {
  const what = r.action === 'approve' ? 'Approved' : `Corrected to ${r.correctedValue}`;
  const note = r.note ? ` (note: ${r.note})` : '';
  return `${what}${note} · ${new Date(r.createdAt).toLocaleString()}`;
}

interface Props {
  valueId: string;
  field: string;
  opened: boolean;
  onClose: () => void;
}

/**
 * Drawer with a field's history across versions, newest first. The query is enabled only
 * while open, so cards that are never inspected cost no requests.
 */
export function ValueHistory({ valueId, field, opened, onClose }: Props) {
  const history = useQuery({
    queryKey: ['value-history', valueId],
    queryFn: () => apiGet<ValueHistoryDto>(`/values/${valueId}/history`),
    enabled: opened,
  });

  return (
    <Drawer opened={opened} onClose={onClose} position="right" title={`History: ${field}`}>
      {history.isPending && <Loader />}
      {history.isError && (
        <Alert color="red" title="Could not load history">
          {history.error.message}
        </Alert>
      )}
      {history.data && (
        <Timeline active={0} bulletSize={16}>
          {history.data.entries.map((e) => (
            <Timeline.Item key={e.valueId} title={`v${e.versionNo}`}>
              <Text size="sm">{e.value ?? `Gap: ${e.gapReason ?? 'No value found'}`}</Text>
              {e.evidence && (
                <Blockquote
                  p="xs"
                  cite={e.evidencePage !== null ? `page ${e.evidencePage}` : undefined}
                >
                  {e.evidence}
                </Blockquote>
              )}
              {e.carriedReview && (
                <Text size="xs" c="dimmed">
                  Carried over: {reviewLine(e.carriedReview)}
                </Text>
              )}
              {e.reviews.map((r) => (
                <Text key={r.id} size="xs" c="dimmed">
                  {reviewLine(r)}
                </Text>
              ))}
            </Timeline.Item>
          ))}
        </Timeline>
      )}
    </Drawer>
  );
}
