import { Alert, Box, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { DocumentType, type DocumentSummaryDto } from '@lomi/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { apiGet, apiUpload, type Health } from '../api';
import { uploadErrorMessage } from '../lib/format';
import { palette } from '../theme';
import { PdfDrop } from './PdfDrop';

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
        <Select
          label="Type"
          placeholder="Document type"
          data={DocumentType.options}
          radius="xl"
          value={type}
          onChange={setType}
          required
          // The options list renders in a portal (outside the sidebar), so it is styled by class
          // to match the cream fields instead of Mantine's white (layout.css).
          classNames={{ dropdown: 'field-dropdown', option: 'field-option' }}
        />
        <TextInput
          label="Title (optional)"
          radius="xl"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <PdfDrop label="PDF" file={file} onChange={setFile} />
        <Button className="upload-btn" type="submit" fullWidth loading={upload.isPending} disabled={!type || !file}>
          Upload
        </Button>
        {errMessage && (
          <Alert color="red" title="Upload failed">
            {errMessage}
          </Alert>
        )}
      </Stack>
    </form>
  );
}

/** API health (same query as before): coloured dot plus text, so it never relies on colour alone. */
function ApiHealth() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<Health>('/health'),
    refetchInterval: 10_000,
    retry: false,
  });

  const connected = health.data?.pg === 'ok' && health.data?.redis === 'ok';
  const dot = health.isPending ? '#A8A196' : connected ? palette.sage : palette.rose;

  return (
    <Group gap="xs" role="status">
      <Box w={10} h={10} style={{ borderRadius: 999, background: dot, flexShrink: 0 }} />
      <Text size="sm">
        {health.isPending ? 'Checking API…' : connected ? 'API connected' : 'API unavailable'}
      </Text>
    </Group>
  );
}

/**
 * Fixed left sidebar on every page: the upload form on top, API health at the bottom. Styled
 * by layout.css (ink card, fixed on wide screens, a plain block above the content below 1000px).
 */
export function Sidebar() {
  return (
    <aside className="app-sidebar">
      <UploadForm />
      <div className="app-sidebar-foot">
        <ApiHealth />
      </div>
    </aside>
  );
}
