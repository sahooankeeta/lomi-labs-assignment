import { Alert, Anchor, Button, Card, Group, Loader, Stack, Table, Text } from '@mantine/core';
import type { DocumentListItemDto } from '@lomi/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { apiGet } from '../api';
import { DocumentTypePill } from '../components/DocumentTypePill';
import { ReviewStatusPill } from '../components/ReviewStatusPill';
import { StatCard, StatIcons } from '../components/StatCard';
import { progressLabel } from '../lib/format';
import { pollInterval } from '../lib/poll';
import { palette } from '../theme';
import './documentTable.css';

/**
 * The three pastel tiles above the table, counted client-side from the list already fetched
 * (no extra request): documents, values still pending review, and versions still extracting.
 */
function ListStats({ docs }: { docs: DocumentListItemDto[] }) {
  const pending = docs.reduce((n, d) => n + d.progress.pending, 0);
  const docsWithPending = docs.filter((d) => d.progress.pending > 0).length;
  const running = docs.filter((d) => d.status === 'queued' || d.status === 'extracting').length;
  const ready = docs.filter((d) => d.status === 'extracted').length;

  return (
    <Group gap="md" align="stretch">
      <StatCard
        bg={palette.blush}
        icon={StatIcons.documents}
        label="Documents"
        value={docs.length}
        caption="Total uploaded documents"
        chip={`${ready} extracted`}
      />
      <StatCard
        bg={palette.sky}
        icon={StatIcons.review}
        label="Needs review"
        value={pending}
        caption="Values waiting for a decision"
        chip={`in ${docsWithPending} ${docsWithPending === 1 ? 'doc' : 'docs'}`}
      />
      <StatCard
        bg={palette.butter}
        icon={StatIcons.clock}
        label="Extracting"
        value={running}
        caption="Documents queued or extracting"
        chip={running > 0 ? 'updating live' : 'all settled'}
      />
    </Group>
  );
}

/** Home page: upload column plus stats and the document table, polling while extractions run. */
export function DocumentList() {
  const docs = useQuery({
    queryKey: ['documents'],
    queryFn: () => apiGet<DocumentListItemDto[]>('/documents'),
    refetchInterval: (q) => pollInterval(q.state.data?.map((d) => d.status) ?? []),
  });

  return (
    <Stack gap="lg">
      {docs.data && <ListStats docs={docs.data} />}
      {docs.isPending && <Loader />}
      {docs.isError && (
        <Alert color="red" title="Could not load documents">
          <Group>
            <Text size="sm">{docs.error.message}</Text>
            <Button size="xs" variant="light" onClick={() => void docs.refetch()}>
              Retry
            </Button>
          </Group>
        </Alert>
      )}
      {docs.data?.length === 0 && <Text c="dimmed">No documents yet — upload one above.</Text>}
      {docs.data && docs.data.length > 0 && (
        <Card p="md">
          {/* Styled by documentTable.css: ink pill header bar, rounded row hover. */}
          <Table
            className="doc-table"
            verticalSpacing="md"
            horizontalSpacing="md"
            withColumnBorders={false}
            withRowBorders={false}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Review</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {docs.data.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td>
                    <Anchor component={Link} to={`/documents/${d.id}`} c={palette.ink} fw={600}>
                      {d.title}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <DocumentTypePill type={d.type} />
                  </Table.Td>
                  <Table.Td>v{d.versionNo}</Table.Td>
                  <Table.Td>
                    <ReviewStatusPill status={d.status} progress={d.progress} />
                  </Table.Td>
                  <Table.Td>{progressLabel(d.progress)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}
