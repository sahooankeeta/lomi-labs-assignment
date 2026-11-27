import {
  Alert,
  Anchor,
  Button,
  FileInput,
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
import { ApiRequestError, apiGet, apiUpload } from '../api';
import { StatusPill } from '../components/StatusPill';
import { progressLabel } from '../lib/format';
import { pollInterval } from '../lib/poll';

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

  const err = upload.error;
  const errMessage =
    err instanceof ApiRequestError && err.status === 413
      ? 'file is larger than 20 MB'
      : err?.message;

  return (
    <form onSubmit={submit}>
      <Stack>
        <Group align="flex-end" grow>
          <Select
            label="Type"
            placeholder="Document type"
            data={DocumentType.options}
            value={type}
            onChange={setType}
            required
          />
          <TextInput
            label="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <FileInput
            label="PDF"
            placeholder="Choose a PDF"
            accept="application/pdf"
            value={file}
            onChange={setFile}
            required
          />
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

/** Home page: upload form plus the document table, polling while extractions run. */
export function DocumentList() {
  const docs = useQuery({
    queryKey: ['documents'],
    queryFn: () => apiGet<DocumentListItemDto[]>('/documents'),
    refetchInterval: (q) => pollInterval(q.state.data?.map((d) => d.status) ?? []),
  });

  return (
    <Stack>
      <Title order={2}>Documents</Title>
      <UploadForm />
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
        <Table>
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
                  <Anchor component={Link} to={`/documents/${d.id}`}>
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
      )}
    </Stack>
  );
}
