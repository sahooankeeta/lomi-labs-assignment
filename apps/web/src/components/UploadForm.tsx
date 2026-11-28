import { Alert, Button, Select, Stack, Text, TextInput } from '@mantine/core';
import { DocumentType, type DocumentSummaryDto } from '@lomi/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { apiUpload } from '../api';
import { uploadErrorMessage } from '../lib/format';
import { PdfDrop } from './PdfDrop';

/** Upload form: picks a type, optional title and a PDF, then opens the created document. */
export function UploadForm() {
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
        <Button
          className="upload-btn"
          type="submit"
          fullWidth
          loading={upload.isPending}
          disabled={!type || !file}
        >
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
