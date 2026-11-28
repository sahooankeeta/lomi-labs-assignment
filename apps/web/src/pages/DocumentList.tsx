import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { DocumentType, type DocumentListItemDto, type DocumentSummaryDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiGet, apiUpload } from '../api';
import { PdfDrop } from '../components/PdfDrop';
import { StatCard, StatIcons } from '../components/StatCard';
import { StatusPill } from '../components/StatusPill';
import { progressLabel, uploadErrorMessage } from '../lib/format';
import { pollInterval } from '../lib/poll';
import { palette } from '../theme';

/** Upload form: picks a type, optional title and a PDF, then opens the created document. */
function UploadForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [type, setType] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: (form: FormData) => apiUpload<DocumentSummaryDto>('/documents', form),
    // 201 (new) and 200 (identical file already uploaded) both carry the document id.
    onSuccess: (doc) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void navigate(`/documents/${doc.id}`);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!type || !file) return;
    const form = new FormData();
    // Text fields before the file so the server sees them while streaming the upload.
    form.append('type', type);
    if (title.trim()) form.append('title', title.trim());
    form.append('file', file);
    upload.mutate(form);
  };

  const errMessage = upload.isError ? uploadErrorMessage(upload.error) : null;

  return (
    <form onSubmit={submit}>
      <Stack>
        <Text fw={600} fz="lg">
          Upload a document
        </Text>
        <Group align="flex-end" grow>
          <Select
            label="Type"
            placeholder="Document type"
            data={DocumentType.options}
            radius="xl"
            value={type}
            onChange={setType}
            required
          />
          <TextInput
            label="Title (optional)"
            radius="xl"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <PdfDrop label="PDF" file={file} onChange={setFile} />
        </Group>
        <Group>
          <Button type="submit" loading={upload.isPending} disabled={!type || !file}>
            Upload
          </Button>
        </Group>
        {errMessage && (
          <Alert color="red" title="Upload failed">
            {errMessage}
          </Alert>
        )}
      </Stack>
    </form>
  );
}

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

/** Home page: upload form plus the document table, polling while extractions run. */
export function DocumentList() {
  const docs = useQuery({
    queryKey: ['documents'],
    queryFn: () => apiGet<DocumentListItemDto[]>('/documents'),
    refetchInterval: (q) => pollInterval(q.state.data?.map((d) => d.status) ?? []),
  });

  return (
    <Stack gap="lg">
      <Title order={1}>Your documents &amp; reviews</Title>
      {docs.data && <ListStats docs={docs.data} />}
      <Card p="lg">
        <UploadForm />
      </Card>
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
          <Table
            verticalSpacing="md"
            horizontalSpacing="md"
            highlightOnHover
            highlightOnHoverColor={palette.panel}
          >
            <Table.Thead bg={palette.panel}>
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
                  <Table.Td>{d.type}</Table.Td>
                  <Table.Td>v{d.versionNo}</Table.Td>
                  <Table.Td>
                    <StatusPill status={d.status} />
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
