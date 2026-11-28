import { Alert, Button, Stack } from '@mantine/core';
import type { DocumentSummaryDto } from '@lomi/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiUpload } from '../api';
import { uploadErrorMessage } from '../lib/format';
import { PdfDrop } from './PdfDrop';

interface Props {
  documentId: string;
}

/**
 * The sidebar's "New version" upload (drop area plus button). Only offered while the current
 * version is shown, since only it can be replaced; the parent decides that. The version
 * picker itself lives in VersionTiles above the review.
 */
export function NewVersionUpload({ documentId }: Props) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('file', f);
      return apiUpload<DocumentSummaryDto>(`/documents/${documentId}/versions`, form);
    },
    // 201 (new version) and 200 (identical to current) both just need a refresh.
    onSuccess: () => {
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['versions', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });

  return (
    <Stack gap="md">
      <Stack gap={10}>
        <PdfDrop label="New version" file={file} onChange={setFile} />
        <Button
          className="upload-btn"
          size="sm"
          fullWidth
          loading={upload.isPending}
          disabled={!file}
          onClick={() => file && upload.mutate(file)}
        >
          Upload new version
        </Button>
      </Stack>
      {upload.isError && (
        <Alert color="red" title="Upload failed">
          {uploadErrorMessage(upload.error)}
        </Alert>
      )}
    </Stack>
  );
}
